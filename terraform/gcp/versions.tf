terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}

# 認証は gcloud auth application-default login の資格情報を使う
provider "google" {
  project = var.project_id
  region  = var.region
}
