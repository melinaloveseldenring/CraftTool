
const chalk = require("chalk");
const figlet = require("figlet");
const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { status } = require("minecraft-server-util");

// ==========================================
// CRAFTTOOL CONFIGURATION
// ==========================================

const VERSION = "2.0.0";
const INTERVAL = 60 * 1000;
const TIMEOUT = 8000;

const DATA_DIR = path.join(__dirname, "data");
const LOG_FILE = path.join(DATA_DIR, "server-history.csv");
const EXPORT_DIR = path.join(__dirname, "reports");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(EXPORT_DIR, { recursive: true });

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const ask = question => new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
});

// Minecraft colors
const oak = chalk.hex("#A66A35");
const lightOak = chalk.hex("#D69B55");
const darkOak = chalk.hex("#542F19");
const green = chalk.hex("#55CC77");
const red = chalk.hex("#FF5555");
const blue = chalk.hex("#55AAFF");
const gray = chalk.gray;

// ==========================================
// DATABASE (CSV)
// ==========================================

const HEADERS = [
    "timestamp",
    "domain",
    "host",
    "port",
    "ip",
    "online",
    "maximum",
    "latency",
    "motd",
    "count_change"
];

function csvEscape(value) {
    return '"' + String(value ?? "").replace(/"/g, '""') + '"';
}

function initializeDatabase() {
    if (!fs.existsSync(LOG_FILE)) {
        fs.writeFileSync(LOG_FILE, HEADERS.join(",") + "\n");
    }
}

function saveRecord(record) {
    initializeDatabase();

    const row = HEADERS.map(key => csvEscape(record[key])).join(",");

    fs.appendFileSync(LOG_FILE, row + "\n");
}

function readRecords() {
    initializeDatabase();

    const lines = fs.readFileSync(LOG_FILE, "utf8")
        .split(/\r?\n/)
        .filter(Boolean);

    if (lines.length < 2) return [];

    return lines.slice(1).map(line => {
        const values = [];
        let current = "";
        let quoted = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                if (quoted && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    quoted = !quoted;
                }
            } else if (char === "," && !quoted) {
                values.push(current);
                current = "";
            } else {
                current += char;
            }
        }

        values.push(current);

        return Object.fromEntries(
            HEADERS.map((key, index) => [key, values[index] || ""])
        );
    });
}

// ==========================================
// TERMINAL INTERFACE
// ==========================================

function craftingTable() {
    const rows = [
        "  ┌───────────────────────────────┐",
        "  │                               │",
        "  │  ┌───────┐ ┌───────┐          │",
        "  │  │░░░░░░░│ │░░░░░░░│          │",
        "  │  │░░░░░░░│ │░░░░░░░│          │",
        "  │  └───────┘ └───────┘          │",
        "  │                               │",
        "  │  ┌───────┐ ┌───────┐          │",
        "  │  │░░░░░░░│ │░░░░░░░│          │",
        "  │  │░░░░░░░│ │░░░░░░░│          │",
        "  │  └───────┘ └───────┘          │",
        "  │                               │",
        "  └───────────────────────────────┘"
    ];

    for (const line of rows) {
        console.log(
            oak(
                line.replace(/░/g, lightOak("▒"))
                    .replace(/[┌┐└┘─│]/g, char => darkOak(char))
            )
        );
    }
}

function header() {
    console.clear();
    craftingTable();

    console.log();

    console.log(
        lightOak(
            figlet.textSync("CraftTool", {
                font: "ANSI Shadow"
            })
        )
    );

    console.log(
        gray("           MINECRAFT SERVER DASHBOARD")
    );

    console.log(
        gray("                  Version " + VERSION)
    );

    console.log();
    console.log(darkOak("  ═════════════════════════════════════════════"));
    console.log();
}

function section(title) {
    console.log();
    console.log(lightOak("  " + title));
    console.log(darkOak("  ─────────────────────────────────────"));
}

// ==========================================
// DOMAIN PARSING & DNS
// ==========================================

function parseAddress(input) {
    let value = input.trim()
        .replace(/^https?:\/\//i, "")
        .split("/")[0];

    let domain = value;
    let port = 25565;

    const match = value.match(/^(.+):(\d+)$/);

    if (match && value.split(":").length === 2) {
        domain = match[1];
        port = Number(match[2]);
    }

    if (
        !domain ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
    ) {
        throw new Error("Invalid server address or port.");
    }

    return { domain, port };
}

async function resolveServer(domain, defaultPort) {
    console.log(blue("[DNS]") + " Checking Minecraft SRV records...");

    let host = domain;
    let port = defaultPort;
    let srvFound = false;

    try {
        const records = await dns.resolveSrv(
            `_minecraft._tcp.${domain}`
        );

        if (records.length > 0) {
            records.sort((a, b) => {
                if (a.priority !== b.priority) {
                    return a.priority - b.priority;
                }

                return b.weight - a.weight;
            });

            host = records[0].name.replace(/\.$/, "");
            port = records[0].port;
            srvFound = true;

            console.log(green("[DNS]") +
                ` SRV found: ${host}:${port}`);
        }
    } catch {
        console.log(gray("[DNS] No SRV record found."));
    }

    let addresses = [];

    try {
        const ipv4 = await dns.resolve4(host);
        addresses.push(...ipv4);
    } catch {}

    try {
        const ipv6 = await dns.resolve6(host);
        addresses.push(...ipv6);
    } catch {}

    addresses = [...new Set(addresses)];

    if (addresses.length === 0) {
        throw new Error("No A or AAAA records could be resolved.");
    }

    console.log(green("[DNS]") +
        ` Resolved ${addresses.length} address(es).`);

    if (!srvFound) {
        console.log(gray("[DNS] Using standard port " + port));
    }

    return {
        host,
        port,
        addresses,
        ip: addresses[0],
        srvFound
    };
}

// ==========================================
// IP GEOLOCATION
// ==========================================

async function geolocation(ip) {
    console.log(blue("[NETWORK]") +
        " Looking up hosting information...");

    try {
        const url = `https://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,isp,org,as,query`;

        const response = await fetch(url, {
            signal: AbortSignal.timeout(TIMEOUT)
        });

        if (!response.ok) {
            throw new Error("Geolocation service unavailable.");
        }

        const data = await response.json();

        if (data.status !== "success") {
            throw new Error(data.message || "Lookup failed.");
        }

        return {
            ip: data.query,
            country: data.country,
            isp: data.isp,
            organization: data.org,
            asn: data.as
        };

    } catch (error) {
        console.log(red("[NETWORK]") +
            " Geolocation unavailable: " + error.message);

        return null;
    }
}

// ==========================================
// MOTD CLEANER
// ==========================================

function cleanMotd(value) {
    if (typeof value === "string") {
        return value
            .replace(/§[0-9a-fk-or]/gi, "")
            .replace(/\u00a7[0-9a-fk-or]/gi, "")
            .replace(/<[^>]*>/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    if (Array.isArray(value)) {
        return value.map(cleanMotd).join(" ");
    }

    if (value && typeof value === "object") {
        if (typeof value.text === "string") {
            return cleanMotd(value.text) +
                (value.extra ? cleanMotd(value.extra) : "");
        }

        return Object.values(value).map(cleanMotd).join(" ");
    }

    return "";
}

// ==========================================
// SERVER ICON
// ==========================================

function saveFavicon(favicon, domain) {
    if (!favicon || typeof favicon !== "string") return null;

    try {
        const base64 = favicon.replace(
            /^data:image\/png;base64,/,
            ""
        );

        if (!/^[A-Za-z0-9+/=]+$/.test(base64)) {
            return null;
        }

        const filename = domain.replace(/[^a-z0-9.-]/gi, "_");
        const iconPath = path.join(
            DATA_DIR,
            filename + "-icon.png"
        );

        fs.writeFileSync(iconPath, Buffer.from(base64, "base64"));

        return iconPath;
    } catch {
        return null;
    }
}

// ==========================================
// SERVER LIST PING
// ==========================================

async function pingServer(host, port) {
    try {
        const start = Date.now();

        const result = await status(host, port, {
            timeout: TIMEOUT,
            enableSRV: false
        });

        const latency = Number.isFinite(result.roundTripLatency)
            ? result.roundTripLatency
            : Date.now() - start;

        const players = result.players || {};
        const sample = Array.isArray(players.sample)
            ? players.sample
            : [];

        return {
            online: true,
            host,
            port,
            onlinePlayers: players.online ?? 0,
            maximum: players.max ?? 0,
            latency,
            motd: cleanMotd(result.motd?.clean ?? result.motd),
            version: result.version?.name || "Unknown",
            sample: sample.map(player => ({
                name: player.name,
                uuid: player.id
            })),
            favicon: result.favicon || null
        };

    } catch (error) {
        return {
            online: false,
            error: error.message
        };
    }
}

// ==========================================
// SCANNING
// ==========================================

let currentServer = null;
let trackingTimer = null;
let trackingBusy = false;
let previousCount = null;

async function scanServer(input) {
    header();

    let parsed;

    try {
        parsed = parseAddress(input);
    } catch (error) {
        console.log(red("[ERROR] " + error.message));
        return;
    }

    console.log(blue("[SCAN]") +
        ` Starting scan for ${parsed.domain}`);

    let resolved;

    try {
        resolved = await resolveServer(
            parsed.domain,
            parsed.port
        );
    } catch (error) {
        console.log(red("[ERROR] " + error.message));
        return;
    }

    const geo = await geolocation(resolved.ip);

    section("NETWORK INFORMATION");

    console.log("Domain:       " + parsed.domain);
    console.log("Backend:      " + resolved.host);
    console.log("Port:         " + resolved.port);
    console.log("IP:           " + resolved.ip);
    console.log("SRV:          " +
        (resolved.srvFound ? green("Found") : gray("Not found")));

    if (geo) {
        console.log("Country:      " + geo.country);
        console.log("ISP:          " + geo.isp);
        console.log("Organization: " + geo.organization);
        console.log("ASN:          " + geo.asn);
    }

    console.log();
    console.log(blue("[SLP]") + " Querying Minecraft server...");

    const result = await pingServer(
        resolved.host,
        resolved.port
    );

    if (!result.online) {
        console.log(red("[OFFLINE]") +
            " Server could not be reached.");
        console.log(gray(result.error));
        return;
    }

    currentServer = {
        domain: parsed.domain,
        ...resolved,
        geo
    };

    displayServer(result);

    const icon = saveFavicon(
        result.favicon,
        parsed.domain
    );

    if (icon) {
        console.log(green("[ICON]") +
            " Saved server icon: " + icon);
    }

    previousCount = result.onlinePlayers;

    saveSnapshot(result, 0);

    console.log();
    console.log(green("[SUCCESS]") +
        " Server scan completed.");

    startTracking();
}

// ==========================================
// DISPLAY SERVER INFORMATION
// ==========================================

function displayServer(result) {
    section("SERVER STATUS");

    console.log("Status:       " + green("ONLINE"));
    console.log("Version:      " + result.version);
    console.log("Players:      " +
        lightOak(`${result.onlinePlayers}/${result.maximum}`));
    console.log("Latency:      " + result.latency + " ms");
    console.log("MOTD:         " + (result.motd || "Unavailable"));

    section("PUBLIC PLAYER SAMPLE");

    if (result.sample.length > 0) {
        for (const player of result.sample) {
            console.log(green("  • ") + player.name);
        }
    } else {
        console.log(gray("  No public sample provided."));
    }

    console.log();
}

// ==========================================
// HISTORY STORAGE
// ==========================================

function saveSnapshot(result, change) {
    saveRecord({
        timestamp: new Date().toISOString(),
        domain: currentServer.domain,
        host: currentServer.host,
        port: currentServer.port,
        ip: currentServer.ip,
        online: result.onlinePlayers,
        maximum: result.maximum,
        latency: result.latency,
        motd: result.motd,
        count_change: change
    });
}

// ==========================================
// BACKGROUND MONITORING
// ==========================================

function startTracking() {
    if (trackingTimer) {
        clearInterval(trackingTimer);
    }

    console.log(
        green("[TRACKER]") +
        " Automatic monitoring started (60 seconds)."
    );

    trackingTimer = setInterval(async () => {
        if (!currentServer || trackingBusy) return;

        trackingBusy = true;

        try {
            const result = await pingServer(
                currentServer.host,
                currentServer.port
            );

            if (!result.online) {
                console.log(
                    red("[TRACKER] Server is offline.")
                );
                return;
            }

            const change = previousCount === null
                ? 0
                : result.onlinePlayers - previousCount;

            previousCount = result.onlinePlayers;

            saveSnapshot(result, change);

            const changeText = change > 0
                ? green(" +" + change)
                : change < 0
                    ? red(" " + change)
                    : gray(" 0");

            console.log(
                gray("[" + new Date().toLocaleTimeString() + "] ") +
                blue("[TRACKER] ") +
                `Players: ${result.onlinePlayers}/${result.maximum}` +
                changeText +
                gray(" | " + result.latency + "ms")
            );

        } catch (error) {
            console.log(red("[TRACKER] " + error.message));
        } finally {
            trackingBusy = false;
        }

    }, INTERVAL);
}

function stopTracking() {
    if (trackingTimer) {
        clearInterval(trackingTimer);
        trackingTimer = null;
    }

    console.log(gray("Background monitoring stopped."));
}

// ==========================================
// VIEW TRACKING LOGS
// ==========================================

function viewLogs() {
    header();

    const records = readRecords().slice(-25).reverse();

    section("RECENT MONITORING HISTORY");

    if (records.length === 0) {
        console.log(gray("No monitoring records found."));
        return;
    }

    for (const record of records) {
        console.log(
            gray(record.timestamp) +
            " | " +
            lightOak(record.domain) +
            " | Players: " +
            green(record.online + "/" + record.maximum) +
            " | " +
            record.latency + "ms"
        );

        if (Number(record.count_change) !== 0) {
            console.log(
                gray("    Player count change: ") +
                (Number(record.count_change) > 0
                    ? green("+" + record.count_change)
                    : red(record.count_change))
            );
        }
    }

    console.log();
    console.log(gray("Showing latest 25 records."));
}

// ==========================================
// HISTORICAL SEARCH
// ==========================================

async function searchHistory() {
    header();

    const query = await ask(
        lightOak("  Enter server domain: ")
    );

    if (!query) return;

    const records = readRecords().filter(record =>
        record.domain.toLowerCase() === query.toLowerCase()
    );

    section("HISTORICAL SERVER STATISTICS");

    if (records.length === 0) {
        console.log(red("No records found for that domain."));
        return;
    }

    const counts = records.map(r => Number(r.online));
    const latencies = records
        .map(r => Number(r.latency))
        .filter(Number.isFinite);

    const average = values =>
        values.reduce((a, b) => a + b, 0) / values.length;

    console.log("Domain:          " + query);
    console.log("Snapshots:       " + records.length);
    console.log("First recorded:  " + records[0].timestamp);
    console.log("Last recorded:   " +
        records[records.length - 1].timestamp);
    console.log("Peak players:    " + Math.max(...counts));
    console.log("Average players: " + average(counts).toFixed(2));
    console.log("Average RTT:     " +
        average(latencies).toFixed(2) + " ms");

    console.log();
    console.log(gray("This is recorded monitoring history, not"));
    console.log(gray("a guarantee of continuous server uptime."));
}

// ==========================================
// REPORT EXPORT
// ==========================================

function exportReport() {
    header();

    const records = readRecords();

    if (records.length === 0) {
        console.log(red("Nothing to export."));
        return;
    }

    const filename =
        "CraftTool-Report-" +
        new Date().toISOString().replace(/[:.]/g, "-") +
        ".csv";

    const destination = path.join(EXPORT_DIR, filename);

    const content = [
        HEADERS.join(","),
        ...records.map(record =>
            HEADERS.map(key => csvEscape(record[key])).join(",")
        )
    ].join("\n");

    fs.writeFileSync(destination, content);

    console.log(green("[EXPORT]") + " Report created!");
    console.log(lightOak(destination));
    console.log(gray("Records exported: " + records.length));
}

// ==========================================
// MAIN MENU
// ==========================================

async function menu() {
    header();

    console.log(lightOak("  SERVER ADMINISTRATION"));
    console.log();

    console.log("  " + green("[1]") + " Scan a new server");
    console.log("  " + green("[2]") + " View live tracking logs");
    console.log("  " + green("[3]") + " Search historical database");
    console.log("  " + green("[4]") + " Export monitoring report");
    console.log("  " + green("[5]") + " Show current server status");
    console.log("  " + green("[6]") + " Stop background tracking");
    console.log("  " + green("[7]") + " Start background tracking");
    console.log("  " + green("[8]") + " Exit CraftTool");

    console.log();

    const choice = await ask(
        lightOak("  CraftTool") + chalk.gray(" » ")
    );

    switch (choice) {
        case "1": {
            const domain = await ask(
                lightOak("  Enter server domain/IP: ")
            );

            if (domain) await scanServer(domain);
            break;
        }

        case "2":
            viewLogs();
            break;

        case "3":
            await searchHistory();
            break;

        case "4":
            exportReport();
            break;

        case "5": {
            if (!currentServer) {
                console.log(red("No server currently selected."));
                break;
            }

            const result = await pingServer(
                currentServer.host,
                currentServer.port
            );

            if (result.online) {
                displayServer(result);
            } else {
                console.log(red("Server is currently offline."));
            }

            break;
        }

        case "6":
            stopTracking();
            break;

        case "7":
            if (!currentServer) {
                console.log(red("Scan a server first."));
            } else {
                startTracking();
            }
            break;

        case "8":
            stopTracking();
            console.log(lightOak("Thanks for using CraftTool!"));
            rl.close();
            return;

        default:
            console.log(red("Unknown command."));
            console.log(gray("Select an option from 1 to 8."));
    }

    await ask(gray("\n  Press ENTER to continue..."));
    menu();
}

// ==========================================
// START APPLICATION
// ==========================================

async function startup() {
    initializeDatabase();
    header();

    console.log(green("[SYSTEM]") + " CraftTool initialized.");
    console.log(green("[SYSTEM]") + " Monitoring database ready.");
    console.log(gray("[SYSTEM] Node.js " + process.version));

    await new Promise(resolve => setTimeout(resolve, 700));

    menu();
}

rl.on("close", () => {
    stopTracking();
    process.exit(0);
});

process.on("SIGINT", () => {
    stopTracking();
    rl.close();
});

startup().catch(error => {
    console.error(red("[FATAL] " + error.message));
    rl.close();
});
