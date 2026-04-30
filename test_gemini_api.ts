import { GoogleGenerativeAI } from "@google/generative-ai";

async function testGeminiAPI(): Promise<boolean> {
  // Get API key from environment
  const apiKey = process.env.GEMINI_API_KEY || process.argv[2];

  if (!apiKey) {
    console.log("❌ No API key provided");
    console.log("   Usage: GEMINI_API_KEY=your-key npx ts-node test_gemini_api.ts");
    return false;
  }

  try {
    // Initialize the client
    console.log("🔄 Initializing Gemini client...");
    const client = new GoogleGenerativeAI(apiKey);

    // Get the model
    console.log("🔄 Initializing Gemini 3.1 Flash model...");
    const model = client.getGenerativeModel({
      model: "gemini-3.1-flash-lite-preview",
    });

    // Make a test call
    console.log("🔄 Making test API call...");
    const result = await model.generateContent(
      "Say 'API key is working!' in exactly those words."
    );

    const text = result.response.text();

    if (text) {
      console.log("✅ API key is working!");
      console.log(`Response: ${text}`);
      return true;
    } else {
      console.log("❌ No response from API");
      return false;
    }
  } catch (error) {
    console.error(`❌ API call failed: ${error}`);
    return false;
  }
}

// Run the test
testGeminiAPI()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
