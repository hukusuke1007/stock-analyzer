# GCP(Cloud Run + Cloud SQL for PostgreSQL)。HOW_TO_DEPLOY.md の手順を Terraform にしたもの。
# Cloud Run はイメージが存在しないと作れないので、先に Artifact Registry だけを作ってイメージを push してから、全体を apply する。

locals {
  image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}/${var.name}:${var.image_tag}"

  # 渡す秘密の値のうち、空でないものだけを Secret Manager に入れて Cloud Run に渡す
  optional_secrets = {
    for env_name, value in {
      OPENAI_API_KEY   = var.openai_api_key
      CODEX_AUTH_JSON  = var.codex_auth_json
      TYPESAFE_API_KEY = var.typesafe_api_key
    } : env_name => value if value != ""
  }
}

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
  ])

  service = each.value

  # destroy で API を無効にすると、同じプロジェクトの他のリソースまで止まるので残す
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "app" {
  repository_id = var.name
  location      = var.region
  format        = "DOCKER"

  depends_on = [google_project_service.apis]
}

# --- データベース ---

resource "google_sql_database_instance" "db" {
  name             = "${var.name}-db"
  database_version = "POSTGRES_17"
  region           = var.region

  deletion_protection = var.db_deletion_protection

  settings {
    # PostgreSQL 16 以降の既定は Enterprise Plus で、共有コアのマシンを選べないので Enterprise にする
    edition = "ENTERPRISE"
    tier    = var.db_tier

    backup_configuration {
      enabled = true
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "app" {
  name     = "stock"
  instance = google_sql_database_instance.db.name
}

# URL にそのまま入れるので、エンコードの要る記号を使わない
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  name     = "app"
  instance = google_sql_database_instance.db.name
  password = random_password.db.result
}

# --- シークレット ---

resource "google_secret_manager_secret" "database_url" {
  secret_id = "${var.name}-database-url"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

# Cloud Run は Cloud SQL を Unix ソケット(/cloudsql/接続名)として渡すので、ホストを空にして host パラメーターでソケットを指す
resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgresql://${google_sql_user.app.name}:${random_password.db.result}@/${google_sql_database.app.name}?host=/cloudsql/${google_sql_database_instance.db.connection_name}"
}

resource "google_secret_manager_secret" "optional" {
  for_each = nonsensitive(toset(keys(local.optional_secrets)))

  secret_id = "${var.name}-${lower(replace(each.value, "_", "-"))}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "optional" {
  for_each = nonsensitive(toset(keys(local.optional_secrets)))

  secret      = google_secret_manager_secret.optional[each.value].id
  secret_data = local.optional_secrets[each.value]
}

# --- Cloud Run ---

# 既定の Compute Engine のサービスアカウントはプロジェクト全体の編集権限を持つので、アプリ専用のものを作る
resource "google_service_account" "run" {
  account_id   = "${var.name}-run"
  display_name = "${var.name} の Cloud Run"
}

resource "google_project_iam_member" "run_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.run.email}"
}

resource "google_secret_manager_secret_iam_member" "run_database_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

resource "google_secret_manager_secret_iam_member" "run_optional" {
  for_each = google_secret_manager_secret.optional

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

resource "google_cloud_run_v2_service" "app" {
  name     = var.name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  deletion_protection = false

  template {
    service_account = google_service_account.run.email

    # 全銘柄のスキャンは結果を SSE で流し続けるので、リクエストのタイムアウトを延ばす
    timeout = "900s"

    scaling {
      max_instance_count = var.max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.db.connection_name]
      }
    }

    containers {
      image = local.image

      ports {
        container_port = 3000
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      dynamic "env" {
        for_each = google_secret_manager_secret.optional
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = "latest"
            }
          }
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
    }
  }

  # シークレットの中身と読む権限ができてからでないと、リビジョンの起動に失敗する
  depends_on = [
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_version.optional,
    google_secret_manager_secret_iam_member.run_database_url,
    google_secret_manager_secret_iam_member.run_optional,
    google_project_iam_member.run_cloudsql,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count = var.allow_unauthenticated ? 1 : 0

  name     = google_cloud_run_v2_service.app.name
  location = google_cloud_run_v2_service.app.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
