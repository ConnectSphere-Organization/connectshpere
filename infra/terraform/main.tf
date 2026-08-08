terraform {
  required_version = ">= 1.5.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.116.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 2.47.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6.0"
    }
  }
  backend "azurerm" {
    resource_group_name  = "rg-saas-tfstate"
    storage_account_name = "saastfstatestorage"
    container_name       = "tfstate"
    key                  = "terraform.tfstate"
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy = false
    }
  }
}

variable "environment" {
  type        = string
  default     = "prod"
  description = "Target deployment environment (staging/prod)"
}

variable "location" {
  type        = string
  default     = "eastus2"
  description = "Azure region for resources"
}

variable "resource_group_name" {
  type        = string
  default     = "rg-saas-enterprise-prod"
  description = "Primary resource group name"
}
