variable "project_id" {
  description = "GCP のプロジェクト ID"
  type        = string
}

variable "region" {
  description = "Cloud Run・Cloud SQL・Artifact Registry を置くリージョン"
  type        = string
  default     = "asia-northeast1"
}

variable "name" {
  description = "Cloud Run のサービス名など、作るリソースの名前の元"
  type        = string
  default     = "stock-analyzer"
}

variable "image_tag" {
  description = "Artifact Registry に push したイメージのタグ"
  type        = string
  default     = "latest"
}

variable "db_tier" {
  description = "Cloud SQL のマシン。小さな構成で始めるので共有コアの db-f1-micro"
  type        = string
  default     = "db-f1-micro"
}

variable "db_deletion_protection" {
  description = "Cloud SQL を terraform destroy で消せないようにする。アカウントと口座のデータが入るので既定で守る"
  type        = bool
  default     = true
}

variable "allow_unauthenticated" {
  description = "Cloud Run の URL を誰でも開けるようにする。false にするときは IAP などで入口を用意する"
  type        = bool
  default     = true
}

variable "max_instances" {
  description = "Cloud Run のインスタンス数の上限"
  type        = number
  default     = 2
}

# 秘密の値。Terraform の state にも平文で残るので、state は暗号化したリモートの置き場所(GCS など)に置く
variable "openai_api_key" {
  description = "コンテナで Codex を使うときの OpenAI の API キー。空なら渡さない"
  type        = string
  default     = ""
  sensitive   = true
}

variable "codex_auth_json" {
  description = "Codex を ChatGPT のログインで使うときの ~/.codex/auth.json の中身。openai_api_key があればそちらが使われる"
  type        = string
  default     = ""
  sensitive   = true
}

variable "typesafe_api_key" {
  description = "判定の AI を Jev にするときのキー。空なら渡さない"
  type        = string
  default     = ""
  sensitive   = true
}
