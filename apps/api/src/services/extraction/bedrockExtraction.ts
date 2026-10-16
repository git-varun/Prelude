import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { AnthropicExtractionProvider, type MessageParser } from "./anthropicExtraction";

// Claude on Amazon Bedrock through the India geographic inference profile (`in.` prefix: ap-south-1 / ap-south-2
// only), so patient text stays in India. Same prompts, structured-output schema, failure reporting and
// post-processing as the Anthropic provider; only the client differs. Credentials come from the default AWS chain
// (instance role in production, the developer's profile locally) -- no API key is ever passed.
export class BedrockExtractionProvider extends AnthropicExtractionProvider {
  override readonly name = "bedrock";

  constructor(
    private readonly awsRegion: string,
    model: string,
  ) {
    super("", model);
  }

  protected override makeClient(): MessageParser {
    return new AnthropicBedrock({ awsRegion: this.awsRegion });
  }
}
