# Cloudflare(Workers + D1)の土台。
# Worker 本体は Vite でビルドした出力を wrangler deploy で置くので、Terraform では管理しない。
# Terraform が作るのは、Worker より先に要る D1 と、Worker を置いたあとに足す独自ドメイン・Access である。

resource "cloudflare_d1_database" "app" {
  account_id            = var.account_id
  name                  = var.name
  primary_location_hint = var.d1_location_hint
}

# 独自ドメイン。Worker が存在しないと作れないので、wrangler deploy のあとに custom_domain を設定して apply する
resource "cloudflare_workers_custom_domain" "app" {
  count = var.custom_domain == "" ? 0 : 1

  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = var.custom_domain
  service    = var.name
}

# アプリは URL に届く人なら誰でもアカウントを作れるので、自分だけで使うときは Access で URL ごと絞る
resource "cloudflare_zero_trust_access_policy" "allow" {
  count = var.access_domain == "" ? 0 : 1

  account_id = var.account_id
  name       = "${var.name} を使える人"
  decision   = "allow"
  include    = [for email in var.access_allowed_emails : { email = { email = email } }]
}

resource "cloudflare_zero_trust_access_application" "app" {
  count = var.access_domain == "" ? 0 : 1

  account_id       = var.account_id
  name             = var.name
  type             = "self_hosted"
  domain           = var.access_domain
  session_duration = "24h"

  policies = [{
    id         = cloudflare_zero_trust_access_policy.allow[0].id
    precedence = 1
  }]
}
