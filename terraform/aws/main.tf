# AWS(ECS Express Mode + RDS for PostgreSQL)。HOW_TO_DEPLOY.md の手順を Terraform にしたもの。
# ECS のサービスはイメージが存在しないと起動しないので、先に ECR だけを作ってイメージを push してから、全体を apply する。

data "aws_caller_identity" "current" {}

locals {
  image = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"

  # 渡す秘密の値のうち、空でないものだけを Secrets Manager に入れてタスクに渡す
  optional_secrets = {
    for env_name, value in {
      OPENAI_API_KEY   = var.openai_api_key
      CODEX_AUTH_JSON  = var.codex_auth_json
      TYPESAFE_API_KEY = var.typesafe_api_key
    } : env_name => value if value != ""
  }
}

resource "aws_ecr_repository" "app" {
  name = var.name

  image_scanning_configuration {
    scan_on_push = true
  }
}

# --- データベース ---

resource "aws_db_subnet_group" "db" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

# URL にそのまま入れるので、エンコードの要る記号を使わない
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_instance" "db" {
  identifier     = "${var.name}-db"
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.db_instance_class

  allocated_storage = 20
  storage_encrypted = true

  db_name  = "stock"
  username = "app"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.db.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false

  backup_retention_period   = 7
  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-db-final"
}

# --- シークレット ---

# RDS for PostgreSQL 15 以降は TLS の接続しか受け付けないので、イメージに入れた RDS の CA 証明書でサーバーの証明書まで検証する
resource "aws_secretsmanager_secret" "database_url" {
  name = "${var.name}/database-url"
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://${aws_db_instance.db.username}:${random_password.db.result}@${aws_db_instance.db.address}:5432/${aws_db_instance.db.db_name}?sslmode=verify-full&sslrootcert=/app/rds-global-bundle.pem"
}

resource "aws_secretsmanager_secret" "optional" {
  for_each = nonsensitive(toset(keys(local.optional_secrets)))

  name = "${var.name}/${lower(replace(each.value, "_", "-"))}"
}

resource "aws_secretsmanager_secret_version" "optional" {
  for_each = nonsensitive(toset(keys(local.optional_secrets)))

  secret_id     = aws_secretsmanager_secret.optional[each.value].id
  secret_string = local.optional_secrets[each.value]
}

# --- IAM ---

# タスク実行ロール。ECR からイメージを取り、Secrets Manager の値をタスクの環境変数に入れる
resource "aws_iam_role" "execution" {
  name = "${var.name}-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-secrets"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = concat([aws_secretsmanager_secret.database_url.arn], [for s in aws_secretsmanager_secret.optional : s.arn])
    }]
  })
}

# Express Mode が、ロードバランサー・オートスケーリング・ログなどを作るときに使うロール
resource "aws_iam_role" "infrastructure" {
  name = "${var.name}-ecs-infrastructure"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "infrastructure" {
  role       = aws_iam_role.infrastructure.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices"
}

# --- ECS Express Mode ---

resource "aws_ecs_express_gateway_service" "app" {
  service_name            = var.name
  execution_role_arn      = aws_iam_role.execution.arn
  infrastructure_role_arn = aws_iam_role.infrastructure.arn

  # ALB のヘルスチェック。/ はログイン画面へリダイレクトするので、200 を返す /login を見る
  health_check_path = "/login"

  primary_container {
    image          = local.image
    container_port = 3000

    secret {
      name       = "DATABASE_URL"
      value_from = aws_secretsmanager_secret.database_url.arn
    }

    dynamic "secret" {
      for_each = aws_secretsmanager_secret.optional
      content {
        name       = secret.key
        value_from = secret.value.arn
      }
    }
  }

  network_configuration = [{
    subnets         = aws_subnet.public[*].id
    security_groups = [aws_security_group.app.id]
  }]

  scaling_target = [{
    min_task_count            = var.min_tasks
    max_task_count            = var.max_tasks
    auto_scaling_metric       = "AVERAGE_CPU"
    auto_scaling_target_value = 60
  }]

  wait_for_steady_state = true

  # シークレットの中身と読む権限ができてからでないと、タスクの起動に失敗する
  depends_on = [
    aws_secretsmanager_secret_version.database_url,
    aws_secretsmanager_secret_version.optional,
    aws_iam_role_policy.execution_secrets,
    aws_iam_role_policy_attachment.execution,
    aws_iam_role_policy_attachment.infrastructure,
  ]
}
