#!/usr/bin/env bash
# Installs and starts the AWS SSM agent on private RHEL/Amazon Linux EC2 hosts by SSH-ing through an
# SSM-reachable bastion (no cloudflared). Idempotent; safe to re-run.
#
# Usage:
#   scripts/install-ssm-agent.sh <aws-profile> <bastion-instance-id> <pem-file> <private-ip> [<private-ip> ...]
# Example (targets.txt: one "<instance-id> <private-ip> <name>" per line):
#   scripts/install-ssm-agent.sh myprofile i-0123456789abcdef0 ~/.ssh/my-key.pem $(awk '{print $2}' targets.txt)
set -euo pipefail
PROFILE=$1; BASTION=$2; PEM=$3; shift 3
REGION=$(aws configure get region --profile "$PROFILE")
CFG=$(mktemp)
cat > "$CFG" <<CFG
Host bastion
  HostName $BASTION
  User ec2-user
  IdentityFile $PEM
  IdentitiesOnly yes
  ProxyCommand aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --profile $PROFILE --region $REGION
  StrictHostKeyChecking accept-new
  ConnectTimeout 20
Host *
  User ec2-user
  IdentityFile $PEM
  IdentitiesOnly yes
  ProxyJump bastion
  StrictHostKeyChecking accept-new
  ConnectTimeout 20
CFG
REMOTE='set -e
if rpm -q amazon-ssm-agent >/dev/null 2>&1; then echo "already installed"; else
  sudo dnf install -y -q "https://s3.'"$REGION"'.amazonaws.com/amazon-ssm-'"$REGION"'/latest/linux_amd64/amazon-ssm-agent.rpm" >/tmp/ssm-install.log 2>&1 || { tail -5 /tmp/ssm-install.log; exit 1; }
fi
sudo systemctl enable --now amazon-ssm-agent >/dev/null 2>&1
sleep 2; echo "agent: $(systemctl is-active amazon-ssm-agent) $(rpm -q amazon-ssm-agent)"'
for ip in "$@"; do
  printf '%-15s ' "$ip"
  ssh -F "$CFG" "$ip" "$REMOTE" 2>&1 | grep -v 'openssh.com/pq' | tr '\n' ' '; echo
done
rm -f "$CFG"
echo
echo "Waiting 60s for agents to register..."; sleep 60
aws ssm describe-instance-information --profile "$PROFILE" --region "$REGION" \
  --query 'InstanceInformationList[].[InstanceId,PingStatus,PlatformName]' --output table
echo "Now click Rescan in EC2 Remote Access."
