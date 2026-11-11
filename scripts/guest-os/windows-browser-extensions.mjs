import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

const archiveLimit = 32 << 20, expandedLimit = 128 << 20;
const windowsName = value => value && !/[\\/:<>"|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value) &&
  !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) && ![".", ".."].includes(value);
const decoder = new TextDecoder("utf-8", { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(data) { let value = 0xffffffff; for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255]; return (value ^ 0xffffffff) >>> 0; }
export function nativeExtensionID(value, platform = process.platform) {
  const normalized = platform === "win32" ? value.replace(/^[a-z]:/, prefix => prefix.toUpperCase()) : value;
  const bytes = Buffer.from(normalized, platform === "win32" ? "utf16le" : "utf8");
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32).replace(/./g, c => String.fromCharCode(97 + parseInt(c, 16)));
}
export function nativeExtensionIDForPath(value) {
  let ancestor = path.resolve(value); const suffix = [];
  // The final package path does not exist until the preview is installed.
  // Resolve its existing ancestor so Chrome and Cage agree on /tmp aliases,
  // redirected Windows profile paths and the eventual extension ID.
  while (!existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); const parent = path.dirname(ancestor); if (parent === ancestor) throw new Error("Каталог расширения недоступен"); ancestor = parent; }
  return nativeExtensionID(path.join(realpathSync(ancestor), ...suffix));
}

// Parse the bounded ZIP central directory before creating files. This replaces
// the Linux Python executable; permissions remain a preview until installation.
export async function extractWindowsExtensionArchive(archive, directory) {
  const bytes = await readFile(archive);
  if (bytes.length < 22 || bytes.length > archiveLimit) throw new Error("ZIP-архив расширения не должен превышать 32 МБ");
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error("Недопустимый формат ZIP-архива расширения");
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), central = bytes.readUInt32LE(end + 16);
  if (count > 3000 || count !== bytes.readUInt16LE(end + 8) || central + centralSize !== end) throw new Error("После распаковки расширение не должно превышать 128 МБ или 3000 файлов");
  const entries = [], seen = new Set(); let offset = central, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Недопустимый формат ZIP-архива расширения");
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24), nameSize = bytes.readUInt16LE(offset + 28);
    const extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), attributes = bytes.readUInt32LE(offset + 38), local = bytes.readUInt32LE(offset + 42);
    if (offset + 46 + nameSize + extra + comment > end || flags & 1 || ((attributes >>> 16) & 0xf000) === 0xa000 || ![0, 8].includes(method)) throw new Error("Пакет расширения не может содержать символические ссылки, зашифрованные файлы или неподдерживаемый формат сжатия");
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameSize), name = decoder.decode(rawName);
    const components = name.replace(/\/$/, "").split("/");
    if (!components.length || components.some(part => !windowsName(part) || Buffer.byteLength(part) > 255) || seen.has(name.toLowerCase())) throw new Error("Пакет расширения содержит небезопасные или повторяющиеся пути файлов");
    seen.add(name.toLowerCase()); expanded += size;
    if (size > archiveLimit || expanded > expandedLimit) throw new Error("После распаковки расширение не должно превышать 128 МБ, а один файл — 32 МБ");
    if (local + 30 > central || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) !== flags) throw new Error("Недопустимый заголовок ZIP-файла расширения");
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), start = local + 30 + localName + localExtra;
    if (!bytes.subarray(local + 30, local + 30 + localName).equals(rawName) || start + compressed > central) throw new Error("Недопустимый заголовок ZIP-файла расширения");
    entries.push({ name, size, compressed, method, crc, start, directory: name.endsWith("/") }); offset += 46 + nameSize + extra + comment;
  }
  if (offset !== end) throw new Error("Недопустимый каталог ZIP-архива расширения");
  for (const entry of entries) {
    const output = path.join(directory, ...entry.name.split("/"));
    if (entry.directory) { await mkdir(output, { recursive: true, mode: 0o700 }); continue; }
    const encoded = bytes.subarray(entry.start, entry.start + entry.compressed);
    const data = entry.method === 0 ? encoded : inflateRawSync(encoded, { maxOutputLength: archiveLimit });
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error("Проверка содержимого ZIP-файла расширения не пройдена");
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 }); await writeFile(output, data, { flag: "wx", mode: 0o600 });
  }
  let relative = "", manifestPath = path.join(directory, "manifest.json");
  if (!entries.some(e => e.name === "manifest.json")) {
    const matches = entries.filter(e => /^[^/]+\/manifest\.json$/.test(e.name));
    if (matches.length !== 1) throw new Error("Пакет расширения должен содержать manifest.json в корне или в одной вложенной папке");
    relative = matches[0].name.split("/")[0]; manifestPath = path.join(directory, relative, "manifest.json");
  }
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length > 1 << 20) throw new Error("Конфигурация расширения слишком велика");
  const manifest = JSON.parse(decoder.decode(manifestBytes).replace(/^\uFEFF/, ""));
  if (manifest.manifest_version !== 3 || typeof manifest.name !== "string" || !manifest.name || typeof manifest.version !== "string" || !manifest.version) throw new Error("Расширению требуются Manifest V3, имя и версия");
  if (/^[A-Za-z0-9_-]{1,32}$/.test(manifest.default_locale || "")) {
    try {
      const messages = await readFile(path.join(path.dirname(manifestPath), "_locales", manifest.default_locale, "messages.json"));
      if (messages.length < 1 << 20) {
        const values = JSON.parse(decoder.decode(messages).replace(/^\uFEFF/, ""));
        for (const field of ["name", "description"]) { const match = /^__MSG_(.*)__$/.exec(manifest[field]); if (match && typeof values[match[1]]?.message === "string") manifest[field] = values[match[1]].message; }
      }
    } catch { /* A missing locale retains the manifest's original label. */ }
  }
  const permissions = manifest.permissions || [], declaredHosts = manifest.host_permissions || [];
  if (!Array.isArray(declaredHosts)) throw new Error("Недопустимое объявление разрешений расширения");
  const hosts = [...declaredHosts];
  if (!Array.isArray(manifest.content_scripts || [])) throw new Error("Недопустимое объявление разрешений расширения");
  for (const script of manifest.content_scripts || []) { if (!Array.isArray(script.matches || [])) throw new Error("Недопустимое объявление разрешений расширения"); hosts.push(...(script.matches || [])); }
  if (![permissions, hosts].every(items => Array.isArray(items) && items.length <= 300 && items.every(value => typeof value === "string" && value.length <= 2048))) throw new Error("Недопустимое объявление разрешений расширения");
  return { relative: relative || ".", name: manifest.name.slice(0, 200), version: manifest.version.slice(0, 100), description: String(manifest.description || "").slice(0, 1000), key: String(manifest.key || "").slice(0, 8192), permissions: [...new Set(permissions)], hostPermissions: [...new Set(hosts)] };
}
