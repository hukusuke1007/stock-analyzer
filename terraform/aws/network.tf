# アプリと RDS を置く VPC。
# アプリのタスクは Yahoo Finance・OpenAI などに出ていくので、NAT ゲートウェイの費用をかけずに済むようパブリックサブネットに置く。
# RDS はインターネットへの経路のないプライベートサブネットに置き、アプリのタスクからだけ繋げるようにする。

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  # RDS のサブネットグループと ALB はどちらも2つ以上の AZ を求める
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = var.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = var.name }
}

resource "aws_subnet" "public" {
  count = length(local.azs)

  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  map_public_ip_on_launch = true

  tags = { Name = "${var.name}-public-${local.azs[count.index]}" }
}

resource "aws_subnet" "private" {
  count = length(local.azs)

  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)

  tags = { Name = "${var.name}-private-${local.azs[count.index]}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# アプリのタスク。ロードバランサーは VPC の中に置かれるので、受け付けるのは VPC の中からの 3000 番だけにする
# (セキュリティグループの description は ASCII しか使えないので英語で書く)
resource "aws_security_group" "app" {
  name        = "${var.name}-app"
  description = "${var.name} tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "From the load balancer in the VPC"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "Stock prices, AI APIs and ECR"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "${var.name} RDS"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "From the app tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}
