import { describe, expect, it } from "vitest";
import { amzDates, signingKey, sigV4Parts, signV4, uriEncode } from "../src/index.js";

// AWS's published Signature Version 4 examples (the aws-sig-v4-test-suite and the IAM example
// in the AWS General Reference). The credentials are AWS's documented example values.
const creds = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const date = new Date("2015-08-30T12:36:00Z");

describe("SigV4", () => {
  it("derives the signing key of AWS's example", () => {
    expect(signingKey(creds.secretAccessKey, "20120215", "us-east-1", "iam").toString("hex")).toBe(
      "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
    );
  });

  it("formats dates the AWS way", () => {
    expect(amzDates(date)).toEqual({ amzDate: "20150830T123600Z", dateStamp: "20150830" });
  });

  it("get-vanilla", () => {
    const p = sigV4Parts({
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      headers: {},
      body: "",
      region: "us-east-1",
      service: "service",
      credentials: creds,
      date,
    });
    expect(p.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );
    expect(p.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("post-vanilla", () => {
    const p = sigV4Parts({
      method: "POST",
      url: new URL("https://example.amazonaws.com/"),
      headers: {},
      body: "",
      region: "us-east-1",
      service: "service",
      credentials: creds,
      date,
    });
    expect(p.signature).toBe("5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b");
  });

  it("get-vanilla-query-order-key-case: query parameters sorted", () => {
    const p = sigV4Parts({
      method: "GET",
      url: new URL("https://example.amazonaws.com/?Param2=value2&Param1=value1"),
      headers: {},
      body: "",
      region: "us-east-1",
      service: "service",
      credentials: creds,
      date,
    });
    expect(p.canonicalRequest.split("\n")[2]).toBe("Param1=value1&Param2=value2");
    expect(p.signature).toBe("b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
  });

  it("the IAM ListUsers example from the AWS General Reference", () => {
    const p = sigV4Parts({
      method: "GET",
      url: new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"),
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      region: "us-east-1",
      service: "iam",
      credentials: creds,
      date,
    });
    expect(p.signature).toBe("5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
  });

  it("encodes a Bedrock model id's path once more, as AWS expects outside S3", () => {
    const id = "anthropic.claude-opus-5-5-v1:0";
    const url = new URL(
      `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(id)}/converse`,
    );
    expect(url.pathname).toBe("/model/anthropic.claude-opus-5-5-v1%3A0/converse");
    const p = sigV4Parts({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      body: "{}",
      region: "us-east-1",
      service: "bedrock",
      credentials: creds,
      date,
    });
    expect(p.canonicalRequest.split("\n")[1]).toBe(
      "/model/anthropic.claude-opus-5-5-v1%253A0/converse",
    );
  });

  it("signs the session token and leaves Host to the HTTP layer", () => {
    const h = signV4({
      method: "POST",
      url: new URL("https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse"),
      headers: { "content-type": "application/json" },
      body: "{}",
      region: "us-east-1",
      service: "bedrock",
      credentials: { ...creds, sessionToken: "session-token-example" },
      date,
    });
    expect(h.host).toBeUndefined();
    expect(h["x-amz-security-token"]).toBe("session-token-example");
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
    expect(h.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
  });

  it("uriEncode is RFC 3986", () => {
    expect(uriEncode("a b*'()!~-_.")).toBe("a%20b%2A%27%28%29%21~-_.");
  });
});
