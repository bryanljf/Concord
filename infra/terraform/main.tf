data "oci_identity_availability_domains" "available" {
  compartment_id = var.tenancy_ocid
}

data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

locals {
  availability_domain = coalesce(
    var.availability_domain,
    data.oci_identity_availability_domains.available.availability_domains[0].name
  )
  cloud_init = templatefile("${path.module}/cloud-init.tftpl", {
    repo_url    = var.repo_url
    repo_branch = var.repo_branch
  })
}

resource "oci_core_vcn" "concord" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.20.0.0/16"]
  display_name   = "concord-vcn"
  dns_label      = "concord"
}

resource "oci_core_internet_gateway" "concord" {
  compartment_id = var.compartment_ocid
  display_name   = "concord-internet-gateway"
  vcn_id         = oci_core_vcn.concord.id
}

resource "oci_core_route_table" "concord" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.concord.id
  display_name   = "concord-public-route-table"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.concord.id
  }
}

resource "oci_core_security_list" "concord" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.concord.id
  display_name   = "concord-security-list"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  dynamic "ingress_security_rules" {
    for_each = var.allowed_ssh_cidrs
    content {
      protocol    = "6"
      source      = ingress_security_rules.value
      source_type = "CIDR_BLOCK"
      tcp_options {
        min = 22
        max = 22
      }
    }
  }

  ingress_security_rules {
    protocol    = "6"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    tcp_options {
      min = 80
      max = 80
    }
  }

  ingress_security_rules {
    protocol    = "6"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    tcp_options {
      min = 443
      max = 443
    }
  }

  ingress_security_rules {
    protocol    = "6"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    tcp_options {
      min = 7881
      max = 7881
    }
  }

  ingress_security_rules {
    protocol    = "17"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    udp_options {
      min = 50000
      max = 50200
    }
  }
}

resource "oci_core_subnet" "concord" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.concord.id
  cidr_block                 = "10.20.1.0/24"
  display_name               = "concord-public-subnet"
  dns_label                  = "public"
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_route_table.concord.id
  security_list_ids          = [oci_core_security_list.concord.id]
}

resource "oci_core_instance" "concord" {
  availability_domain = local.availability_domain
  compartment_id      = var.compartment_ocid
  display_name        = "concord"
  shape               = var.instance_shape
  freeform_tags       = { project = "concord" }

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_in_gbs
  }

  create_vnic_details {
    assign_public_ip = true
    display_name     = "concord-vnic"
    hostname_label   = "concord"
    subnet_id        = oci_core_subnet.concord.id
  }

  source_details {
    source_id               = data.oci_core_images.ubuntu.images[0].id
    source_type             = "image"
    boot_volume_size_in_gbs = var.boot_volume_size_gbs
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(local.cloud_init)
  }

  # Both attributes force a REPLACEMENT of the VM (new disk, new public IP) when they change:
  # the image data source picks the newest Ubuntu build, which Canonical republishes regularly,
  # and cloud-init only runs on first boot anyway. Ignore them so a routine `terraform apply`
  # never destroys the server; recreate deliberately with `terraform apply -replace=...`.
  lifecycle {
    ignore_changes = [
      source_details[0].source_id,
      metadata["user_data"],
    ]
  }
}
