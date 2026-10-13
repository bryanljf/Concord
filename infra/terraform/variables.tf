variable "tenancy_ocid" {
  type        = string
  description = "OCI tenancy OCID."
}

variable "user_ocid" {
  type        = string
  description = "OCI API user OCID used by Terraform."
}

variable "fingerprint" {
  type        = string
  description = "Fingerprint of the OCI API key."
}

variable "private_key_path" {
  type        = string
  description = "Path to the OCI API private key on the machine running Terraform."
}

variable "region" {
  type        = string
  description = "OCI region, for example sa-saopaulo-1."
}

variable "compartment_ocid" {
  type        = string
  description = "Compartment where the Concord VM and network will be created."
}

variable "availability_domain" {
  type        = string
  default     = null
  description = "Optional availability domain name. The first AD is used when omitted."
}

variable "instance_shape" {
  type        = string
  default     = "VM.Standard.A1.Flex"
  description = "Always Free ARM shape."
}

variable "ocpus" {
  type        = number
  default     = 2
  description = "Number of OCPUs assigned to the VM."
}

variable "memory_in_gbs" {
  type        = number
  default     = 12
  description = "Memory assigned to the VM in GB."
}

variable "boot_volume_size_gbs" {
  type        = number
  default     = 50
  description = "Boot volume size in GB."
}

variable "ssh_public_key" {
  type        = string
  description = "SSH public key installed for the ubuntu user."
}

variable "repo_url" {
  type        = string
  default     = "https://github.com/bryanljf/Concord.git"
  description = "Git repository cloned by cloud-init."
}

variable "repo_branch" {
  type        = string
  default     = "main"
  description = "Repository branch deployed by the VM."
}

variable "allowed_ssh_cidrs" {
  type        = list(string)
  default     = ["0.0.0.0/0"]
  description = "CIDRs allowed to SSH. Restrict this to your IP when possible."
}
