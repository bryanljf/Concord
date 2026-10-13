output "public_ip" {
  value       = oci_core_instance.concord.public_ip
  description = "Public IPv4 address for DuckDNS and GitHub Actions."
}

output "instance_id" {
  value       = oci_core_instance.concord.id
  description = "OCI instance OCID."
}

output "ssh_command" {
  value       = "ssh ubuntu@${oci_core_instance.concord.public_ip}"
  description = "Initial SSH command."
}
