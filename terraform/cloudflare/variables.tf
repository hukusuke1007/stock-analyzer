variable "account_id" {
  description = "Cloudflare のアカウント ID"
  type        = string
}

variable "name" {
  description = "D1 のデータベース名と Worker の名前。wrangler.jsonc の name・database_name と揃える"
  type        = string
  default     = "stock-analyzer"
}

variable "d1_location_hint" {
  description = "D1 を置く地域の目安。日本から使うので既定はアジア太平洋(apac)"
  type        = string
  default     = "apac"
}

variable "custom_domain" {
  description = "Worker に割り当てる独自ドメイン(例: stock.example.com)。空なら workers.dev の URL だけで公開する。Worker を wrangler でデプロイしてから設定する"
  type        = string
  default     = ""
}

variable "zone_id" {
  description = "custom_domain を置くゾーンの ID。custom_domain を使うときだけ必要"
  type        = string
  default     = ""
}

variable "access_domain" {
  description = "Cloudflare Access で守るホスト名(独自ドメイン、または stock-analyzer.<サブドメイン>.workers.dev)。空なら Access を作らない"
  type        = string
  default     = ""
}

variable "access_allowed_emails" {
  description = "Access を通すメールアドレス。access_domain を使うときだけ必要"
  type        = list(string)
  default     = []
}
