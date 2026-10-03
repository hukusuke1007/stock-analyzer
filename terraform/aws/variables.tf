variable "region" {
  description = "置くリージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "name" {
  description = "ECS のサービス名など、作るリソースの名前の元"
  type        = string
  default     = "stock-analyzer"
}

variable "image_tag" {
  description = "ECR に push したイメージのタグ"
  type        = string
  default     = "latest"
}

variable "vpc_cidr" {
  description = "アプリ用に作る VPC のアドレス範囲"
  type        = string
  default     = "10.20.0.0/16"
}

variable "db_instance_class" {
  description = "RDS のインスタンスクラス"
  type        = string
  default     = "db.t4g.micro"
}

variable "db_deletion_protection" {
  description = "RDS を terraform destroy で消せないようにする。アカウントと口座のデータが入るので既定で守る"
  type        = bool
  default     = true
}

variable "min_tasks" {
  description = "タスク数の下限"
  type        = number
  default     = 1
}

variable "max_tasks" {
  description = "タスク数の上限"
  type        = number
  default     = 2
}

# 秘密の値。Terraform の state にも平文で残るので、state は暗号化したリモートの置き場所(S3 など)に置く
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
