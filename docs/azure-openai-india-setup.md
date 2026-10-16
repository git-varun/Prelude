# Azure OpenAI (India) setup

Steps to create the resource the `azure_openai` extraction provider talks to. Portal labels and the model list change
often, so treat names as approximate and check what your subscription offers.

## 1. Create the resource (portal)

1. Sign in at https://portal.azure.com with a subscription that has Azure OpenAI access.
2. **Create a resource → Azure OpenAI** (it may appear as **Azure AI Foundry → Azure OpenAI**).
3. Fill in:
   - **Subscription / Resource group:** a new group, e.g. `prelude-rg`.
   - **Region:** **Central India** or **South India**. Pick one where the model you want is offered (step 2).
   - **Name:** e.g. `prelude-in`. The endpoint becomes `https://prelude-in.openai.azure.com`.
   - **Pricing tier:** Standard S0.
4. **Network:** "All networks" is fine to start; restrict to the server's Elastic IP later.
5. Review + create.

## 2. Deploy a model (Standard, regional)

1. Open the resource → **Go to Azure AI Foundry** (or **Model deployments**) → **Deployments → Deploy model**.
2. Choose a chat model that supports **structured outputs** (GPT-4o / 4.1 / 5-class). If the model you want is not
   listed in your India region, pick another region from Central/South India, or another model.
3. **Deployment type: Standard.** Do not choose Global Standard, Global Batch, Data Zone or Provisioned-Global: those
   can process outside the region.
4. Set a **deployment name** (e.g. `gpt-extract`). This is `AZURE_OPENAI_DEPLOYMENT`, not the model name.
5. Set a tokens-per-minute quota high enough for several concurrent calls (one call per field type per document).

## 3. Collect the values

Resource → **Keys and Endpoint**: copy the endpoint and Key 1.

```sh
# on the server: edit /opt/prelude/.env yourself (keep the key out of chat and git)
EXTRACTION_PROVIDER=azure_openai
AZURE_OPENAI_REGION=centralindia      # or southindia, must match the resource
AZURE_OPENAI_ENDPOINT=https://prelude-in.openai.azure.com
AZURE_OPENAI_API_KEY=<key 1>
AZURE_OPENAI_DEPLOYMENT=gpt-extract
# remove EXTRACTION_MODEL and the AWS_* lines
```

Restart: `sudo docker-compose -f infra/docker-compose.prod.yml --env-file .env up -d` from `/opt/prelude`.
The API refuses to start if the region is not an India value or the endpoint is not an `*.openai.azure.com` https URL.

## 4. Data protection

1. **Abuse monitoring:** by default Microsoft may retain prompts and outputs for up to 30 days. For patient data apply
   for modified abuse monitoring via Microsoft's "Azure OpenAI Limited Access Review: Modified Abuse Monitoring" form.
2. Confirm the data-processing terms (Microsoft Product Terms / DPA) cover your use, and record the result in
   `docs/third-party-services.md` open items.
3. Create the **Document Intelligence** resource used for OCR in the same India region too.

## 5. Verify

Run the extraction eval on the synthetic fixtures:

```sh
AZURE_OPENAI_REGION=centralindia AZURE_OPENAI_ENDPOINT=... AZURE_OPENAI_API_KEY=... AZURE_OPENAI_DEPLOYMENT=... \
  EVAL_PROVIDER=azure_openai bun run eval:extraction
```

Gates: recall >= 98%, value accuracy 100%, all-correct 100%. Only then the real fixtures (PHI; never commit them).
