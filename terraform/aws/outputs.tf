output "url" {
  description = "アプリの HTTPS の URL"
  value       = try("https://${aws_ecs_express_gateway_service.app.ingress_paths[0].endpoint}", null)
}

output "ecr_repository_url" {
  description = "docker push 先のリポジトリ"
  value       = aws_ecr_repository.app.repository_url
}

output "image" {
  description = "タスクが使うイメージ"
  value       = local.image
}
