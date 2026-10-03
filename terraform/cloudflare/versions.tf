terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.26"
    }
  }
}

# API トークンは環境変数 CLOUDFLARE_API_TOKEN で渡す(tfvars やコードに書かない)
provider "cloudflare" {}
