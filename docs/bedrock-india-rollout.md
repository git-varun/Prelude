# Bedrock (India) rollout

Hand-off for switching production extraction to Claude on Amazon Bedrock via the India inference profile
(`in.anthropic.claude-sonnet-5`, routes only between ap-south-1 and ap-south-2). Nothing here has been run for you:
every command below changes AWS or the production server. Background: `docs/third-party-services.md`, "Bedrock (India)".

Facts as audited on 2026-10-16 (account `143853719763`):

- EC2 instance `prelude-mvp` = `i-0b276b5fc0e8f561b`, **ap-southeast-2 (Sydney)**, `t3.small`, role/profile
  `prelude-ec2-backup-role`, IMDSv2 required, hop limit already 2.
- `in.anthropic.claude-sonnet-5` is ACTIVE in ap-south-1 (routes to ap-south-1 + ap-south-2).
- **Model agreement is not accepted**: `GetFoundationModelAvailability` shows `agreementAvailability: NOT_AVAILABLE`
  for every Anthropic model, and calls fail with `403 ... is not available for this account`. Do step 0 first.
- Model invocation logging: `GetModelInvocationLoggingConfiguration` returned `{}` (off) in ap-south-1.

## 0. Accept the Anthropic model agreement (blocks everything)

Console: Bedrock (ap-south-1) > Model catalog > Claude Sonnet 5 > submit the first-time use-case details and accept the
EULA, with a principal that has Marketplace permissions (`aws-marketplace:ViewSubscriptions`, `aws-marketplace:Subscribe`).
Or CLI (needs an offer token from `list-foundation-model-agreement-offers`):

```sh
aws bedrock list-foundation-model-agreement-offers --region ap-south-1 --model-id anthropic.claude-sonnet-5
aws bedrock create-foundation-model-agreement --region ap-south-1 --model-id anthropic.claude-sonnet-5 --offer-token <token>
aws bedrock get-foundation-model-availability --region ap-south-1 --model-id anthropic.claude-sonnet-5   # agreementAvailability should now be AVAILABLE
```

## 1. IAM: let the instance role invoke the India profile

`prelude-ec2-backup-role` exists. Add an inline policy (the inference-profile ARN is in ap-south-1; the foundation
model ARNs are needed in BOTH regions because the profile may route to either):

```sh
cat > bedrock-india-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "InvokeSonnet5IndiaOnly",
    "Effect": "Allow",
    "Action": ["bedrock:InvokeModel"],
    "Resource": [
      "arn:aws:bedrock:ap-south-1:143853719763:inference-profile/in.anthropic.claude-sonnet-5",
      "arn:aws:bedrock:ap-south-1::foundation-model/anthropic.claude-sonnet-5",
      "arn:aws:bedrock:ap-south-2::foundation-model/anthropic.claude-sonnet-5"
    ]
  }]
}
EOF
aws iam put-role-policy --role-name prelude-ec2-backup-role --policy-name bedrock-india-invoke --policy-document file://bedrock-india-policy.json
```

For the local eval, the profile you use needs the same permissions.

## 2. Metadata hop limit (so the Docker container can read the instance role)

Already 2 on `i-0b276b5fc0e8f561b`; verify rather than change:

```sh
aws ec2 describe-instances --region ap-southeast-2 --instance-ids i-0b276b5fc0e8f561b --query 'Reservations[].Instances[].MetadataOptions'
# only if HttpPutResponseHopLimit is 1:
aws ec2 modify-instance-metadata-options --region ap-southeast-2 --instance-id i-0b276b5fc0e8f561b --http-put-response-hop-limit 2 --http-tokens required
```

## 3. Quota for Sonnet 5 cross-region tokens/minute in ap-south-1

```sh
aws service-quotas list-service-quotas --service-code bedrock --region ap-south-1 \
  --query "Quotas[?contains(QuotaName,'Sonnet 5') && contains(QuotaName,'ross-region')].[QuotaName,QuotaCode,Value]" --output table
# raise if too low for the OCR text volume (one call per field type per document):
aws service-quotas request-service-quota-increase --service-code bedrock --region ap-south-1 --quota-code <code> --desired-value <n>
```

## 4. Confirm model invocation logging is off

Logging would copy prompts (patient text) into CloudWatch/S3. Expect `{}` / no `loggingConfig`:

```sh
aws bedrock get-model-invocation-logging-configuration --region ap-south-1
aws bedrock get-model-invocation-logging-configuration --region ap-south-2
# if either returns a loggingConfig:
aws bedrock delete-model-invocation-logging-configuration --region <region>
```

## 5. Production `.env`, deploy, warm-up, audit

On the server `.env`: set `EXTRACTION_PROVIDER=bedrock`, `AWS_REGION=ap-south-1`,
`EXTRACTION_MODEL=in.anthropic.claude-sonnet-5`; **delete** `LLM_API_KEY`, `GEMINI_API_KEY`,
`GEMINI_PILOT_TESTING_ONLY` and any `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_BEARER_TOKEN_BEDROCK`
(credentials must come from the instance role). The API refuses to start if the region or model prefix is wrong.

```sh
./infra/deploy.sh
docker compose -f infra/docker-compose.prod.yml logs api | tail   # no "AWS_REGION must be" / "EXTRACTION_MODEL must start" errors
```

Warm-up: the first call compiles the structured-output grammar (can take minutes, cached 24h). Upload ONE SYNTHETIC
document (never a real report) and wait for extraction to finish; later uploads are fast.

CloudTrail check that `InvokeModel` calls are from India (Bedrock data-plane events appear only if data events are
enabled for the trail; otherwise check the `aws:SourceRegion`/`awsRegion` of the management event history):

```sh
aws cloudtrail lookup-events --region ap-south-1 --lookup-attributes AttributeKey=EventName,AttributeValue=InvokeModel \
  --max-results 20 --query 'Events[].CloudTrailEvent' --output text | jq -r '.awsRegion + " " + .eventName'
# every line should say ap-south-1 (a ap-south-2 hop may also appear); anything else = stop and investigate
```

## 6. Residency caveat: the server is not in India

The EC2 host (and so the Postgres volume and the uploaded documents) is in **ap-southeast-2 (Sydney)**. Switching
the LLM to Bedrock India keeps the *extraction call* in India, but documents and the database would still be stored
outside India, and OCR (Azure/Google Document AI) is a separate processor. For end-to-end India residency the
instance, storage and OCR provider all need to move to ap-south-1 / ap-south-2 (for OCR, region-pinned Azure or
Amazon Textract in ap-south-1 -- `@aws-sdk/client-textract` is already a dependency).
