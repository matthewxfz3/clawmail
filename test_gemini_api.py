#!/usr/bin/env python3
"""Test script for Google Gemini API key"""

import os
import sys

def test_gemini_api():
    # Get API key from environment or prompt
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        api_key = input("Enter your Gemini API key: ").strip()

    if not api_key:
        print("❌ No API key provided")
        return False

    try:
        import google.generativeai as genai
    except ImportError:
        print("❌ google-generativeai not installed")
        print("   Install with: pip install google-generativeai")
        return False

    try:
        # Configure the API
        genai.configure(api_key=api_key)

        # Initialize model
        print("🔄 Initializing Gemini 3.1 Flash model...")
        model = genai.GenerativeModel("gemini-3.1-flash-lite-preview")

        # Make a test call
        print("🔄 Making test API call...")
        response = model.generate_content("Say 'API key is working!' in exactly those words.")

        if response.text:
            print(f"✅ API key is working!")
            print(f"Response: {response.text}")
            return True
        else:
            print("❌ No response from API")
            return False

    except Exception as e:
        print(f"❌ API call failed: {e}")
        return False

if __name__ == "__main__":
    success = test_gemini_api()
    sys.exit(0 if success else 1)
