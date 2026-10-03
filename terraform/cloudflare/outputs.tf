output "d1_database_id" {
  description = "wrangler.jsonc の d1_databases の database_id に書く値"
  value       = cloudflare_d1_database.app.id
}
