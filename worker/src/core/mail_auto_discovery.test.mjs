import assert from "node:assert/strict";
import test from "node:test";

import {
    discoverMailConfig,
    extractEmailDomain,
    isValidEmailDomain,
    parseMozillaIspdbXml,
    buildHeuristicConfig,
} from "./mail_auto_discovery.ts";

test("isValidEmailDomain validates domains and rejects invalid/IP targets", () => {
    assert.equal(isValidEmailDomain("linux.do"), true);
    assert.equal(isValidEmailDomain("gmail.com"), true);
    assert.equal(isValidEmailDomain("sub.domain.co.uk"), true);

    // IP addresses rejected
    assert.equal(isValidEmailDomain("127.0.0.1"), false);
    assert.equal(isValidEmailDomain("192.168.1.1"), false);
    assert.equal(isValidEmailDomain("10.0.0.1"), false);

    // Invalid formats rejected
    assert.equal(isValidEmailDomain("localhost"), false);
    assert.equal(isValidEmailDomain(""), false);
    assert.equal(isValidEmailDomain("domain"), false);
    assert.equal(isValidEmailDomain("domain..com"), false);
});

test("extractEmailDomain correctly parses domain from email", () => {
    assert.equal(extractEmailDomain("mangoqwq@linux.do"), "linux.do");
    assert.equal(extractEmailDomain("user@sub.example.com"), "sub.example.com");
    assert.equal(extractEmailDomain("user@127.0.0.1"), null);
    assert.equal(extractEmailDomain("invalid-email"), null);
    assert.equal(extractEmailDomain("@domain.com"), null);
    assert.equal(extractEmailDomain("user@"), null);
});

test("Tier 1 curated directory matches known providers synchronously", async () => {
    const linuxDoConfig = await discoverMailConfig("test@linux.do");
    assert.equal(linuxDoConfig.discovery_source, "curated_directory");
    assert.equal(linuxDoConfig.host, "mail.linux.do");
    assert.equal(linuxDoConfig.port, 993);
    assert.equal(linuxDoConfig.smtp_host, "mail.linux.do");
    assert.equal(linuxDoConfig.smtp_port, 465);
    assert.equal(linuxDoConfig.source, "imap_custom");

    const qqConfig = await discoverMailConfig("test@qq.com");
    assert.equal(qqConfig.discovery_source, "curated_directory");
    assert.equal(qqConfig.source, "imap_qq");
    assert.equal(qqConfig.host, "imap.qq.com");
    assert.equal(qqConfig.smtp_host, "smtp.qq.com");
});

test("Tier 2 parses Mozilla ISPDB autoconfig XML correctly", () => {
    const mockXml = `<?xml version="1.0"?>
<clientConfig version="1.1">
    <emailProvider id="example.com">
        <domain>example.com</domain>
        <incomingServer type="imap">
            <hostname>mail.example.com</hostname>
            <port>993</port>
            <socketType>SSL</socketType>
            <authentication>password-cleartext</authentication>
        </incomingServer>
        <outgoingServer type="smtp">
            <hostname>smtp.example.com</hostname>
            <port>465</port>
            <socketType>SSL</socketType>
            <authentication>password-cleartext</authentication>
        </outgoingServer>
    </emailProvider>
</clientConfig>`;

    const parsed = parseMozillaIspdbXml(mockXml, "example.com");
    assert.ok(parsed);
    assert.equal(parsed.discovery_source, "ispdb");
    assert.equal(parsed.host, "mail.example.com");
    assert.equal(parsed.port, 993);
    assert.equal(parsed.use_ssl, true);
    assert.equal(parsed.smtp_host, "smtp.example.com");
    assert.equal(parsed.smtp_port, 465);
    assert.equal(parsed.smtp_ssl, true);
});

test("Tier 3 fallback generates heuristic endpoints", async () => {
    // Mock fetchFn returning 404 for unknown domain
    const mockFetch = async () => ({
        ok: false,
        status: 404,
        text: async () => "",
    });

    const config = await discoverMailConfig("user@some-unknown-mail-domain.xyz", mockFetch);
    assert.equal(config.discovery_source, "heuristic");
    assert.equal(config.host, "imap.some-unknown-mail-domain.xyz");
    assert.equal(config.port, 993);
    assert.equal(config.use_ssl, true);
    assert.equal(config.smtp_host, "smtp.some-unknown-mail-domain.xyz");
    assert.equal(config.smtp_port, 465);
    assert.equal(config.smtp_ssl, true);
});
