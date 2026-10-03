output "url" {
  description = "アプリの URL"
  value       = google_cloud_run_v2_service.app.uri
}

output "image" {
  description = "docker push 先のイメージ名"
  value       = local.image
}

output "cloudsql_connection_name" {
  description = "Cloud SQL の接続名(Cloud SQL Auth Proxy で手元から繋ぐときに使う)"
  value       = google_sql_database_instance.db.connection_name
}
