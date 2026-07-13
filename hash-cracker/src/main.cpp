#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace fs = std::filesystem;

namespace {

using Clock = std::chrono::steady_clock;

void logTiming(std::string_view label, Clock::time_point started) {
  const char* timingEnvironment = std::getenv("VOICE_HASH_TIMING");
  if (!timingEnvironment || *timingEnvironment != '1') return;
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - started).count();
  std::cerr << "[timing] " << label << ": " << elapsed << " ms\n";
}

constexpr std::uint64_t fnvPrime = 1099511628211ULL;
constexpr std::uint64_t fnvOffset = 14695981039346656037ULL;

struct Prefix {
  std::string path;
  std::string category;
  std::string speaker;
  bool gameOwned = false;
};

struct HashedPrefix {
  const Prefix* prefix = nullptr;
  std::uint64_t state = 0;
};

struct Language {
  std::string root;
  std::string token;
  std::uint64_t baseState = 0;
  std::unordered_set<std::uint64_t> targetHashes;
  std::unordered_map<std::string, std::vector<HashedPrefix>> prefixesByCategory;
};

struct DialogueId {
  std::string textId;
  std::string category;
  std::string middle;
  std::string contentId;
  std::string lineIndex;
};

struct SourceCandidate {
  std::string source;
  std::string speaker;
  std::string category;
};

struct LocalScene {
  std::string category;
  std::string stem;
  std::string contentId;
  unsigned maxTake = 0;
};

struct NumberedStem {
  std::string stem;
  unsigned maxTake = 0;
};

struct RawPrefix {
  std::string path;
  std::string category;
  std::string speaker;
};

struct Match {
  std::uint64_t hash = 0;
  std::string speaker;
  std::string source;
  std::string sourceKey;
};

using LanguageTokensByRoot = std::unordered_map<std::string, std::unordered_map<std::string, std::unordered_set<std::string>>>;
using TargetHashesByRoot = std::unordered_map<std::string, std::unordered_map<std::string, std::unordered_set<std::uint64_t>>>;

std::string lower(std::string value) {
  for (char& ch : value) {
    if (ch >= 'A' && ch <= 'Z') ch = static_cast<char>(ch + ('a' - 'A'));
  }
  return value;
}

std::uint64_t fold(std::uint64_t state, std::string_view value, bool lowercase = false) {
  for (unsigned char byte : value) {
    if (lowercase && byte >= 'A' && byte <= 'Z') byte = static_cast<unsigned char>(byte + ('a' - 'A'));
    state *= fnvPrime;
    state ^= byte;
  }
  return state;
}

std::uint32_t fnv32(std::string_view value) {
  std::uint32_t hash = 2166136261U;
  for (unsigned char byte : value) {
    if (byte >= 'A' && byte <= 'Z') byte = static_cast<unsigned char>(byte + ('a' - 'A'));
    hash *= 16777619U;
    hash ^= byte;
  }
  return hash;
}

std::unordered_set<std::uint32_t> readNumberArray(std::string_view json, std::string_view key) {
  std::unordered_set<std::uint32_t> values;
  const std::size_t keyPosition = json.find('"' + std::string(key) + '"');
  if (keyPosition == std::string_view::npos) return values;
  const std::size_t start = json.find('[', keyPosition + key.size() + 2);
  const std::size_t end = start == std::string_view::npos ? std::string_view::npos : json.find(']', start + 1);
  if (start == std::string_view::npos || end == std::string_view::npos) return values;
  for (std::size_t index = start + 1; index < end;) {
    while (index < end && !std::isdigit(static_cast<unsigned char>(json[index]))) ++index;
    std::uint64_t value = 0;
    bool found = false;
    while (index < end && std::isdigit(static_cast<unsigned char>(json[index]))) {
      found = true;
      value = value * 10 + static_cast<unsigned>(json[index++] - '0');
    }
    if (found && value <= 0xffffffffULL) values.insert(static_cast<std::uint32_t>(value));
  }
  return values;
}

bool isHex16(std::string_view value) {
  if (value.size() != 16) return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char ch) { return std::isxdigit(ch) != 0; });
}

bool isDigits(std::string_view value) {
  return !value.empty() && std::all_of(value.begin(), value.end(), [](unsigned char ch) { return std::isdigit(ch) != 0; });
}

bool isIdentifier(std::string_view value) {
  if (value.size() < 2 || value.size() > 63 || isDigits(value)) return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char ch) { return std::isalnum(ch) != 0; });
}

std::vector<std::string> split(std::string_view value, char delimiter) {
  std::vector<std::string> result;
  std::size_t start = 0;
  while (start <= value.size()) {
    const std::size_t end = value.find(delimiter, start);
    result.emplace_back(value.substr(start, end == std::string_view::npos ? value.size() - start : end - start));
    if (end == std::string_view::npos) break;
    start = end + 1;
  }
  return result;
}

bool looksLikeLanguageToken(std::string_view value) {
  const std::size_t open = value.find('(');
  const std::size_t close = value.find(')', open == std::string_view::npos ? 0 : open + 1);
  if (open < 2 || close != value.size() - 1 || close == std::string_view::npos) return false;
  return std::all_of(value.begin(), value.begin() + static_cast<std::ptrdiff_t>(open), [](unsigned char ch) { return std::isalpha(ch) != 0; })
    && std::all_of(value.begin() + static_cast<std::ptrdiff_t>(open + 1), value.begin() + static_cast<std::ptrdiff_t>(close), [](unsigned char ch) { return std::isalpha(ch) != 0; });
}

std::optional<std::string> findLanguageToken(const fs::path& file, const fs::path& root) {
  std::optional<std::string> found;
  for (fs::path current = file.parent_path(); current != root; current = current.parent_path()) {
    const std::string token = lower(current.filename().string());
    if (!looksLikeLanguageToken(token)) continue;
    if (found && *found != token) return std::nullopt;
    found = token;
  }
  return found;
}

bool isLanguageRoot(std::string_view value) {
  return value == "cn" || value == "en" || value == "jp" || value == "kr";
}

std::optional<std::string> findLanguageRoot(const fs::path& file, const fs::path& root) {
  for (fs::path current = file.parent_path(); current != root; current = current.parent_path()) {
    const std::string name = lower(current.filename().string());
    if (isLanguageRoot(name)) return name;
  }
  return std::nullopt;
}

void collectLanguageTokens(const fs::path& root, LanguageTokensByRoot& tokensByRoot) {
  if (!fs::is_directory(root)) return;
  const auto scanRoot = [&](const fs::path& languageRoot) {
    const std::string rootName = lower(languageRoot.filename().string());
    auto& tokensByLanguageRoot = tokensByRoot[rootName];
    for (const auto& entry : fs::recursive_directory_iterator(languageRoot, fs::directory_options::skip_permission_denied)) {
      if (!entry.is_regular_file()) continue;
      const std::string filename = entry.path().filename().string();
      const std::size_t extensionStart = filename.size() >= 4 ? filename.size() - 4 : std::string::npos;
      if (extensionStart == std::string::npos) continue;
      const std::string extension = lower(filename.substr(extensionStart));
      if (extension != ".wav" && extension != ".wem") continue;
      // Walk only the directory components below <root>/<language>. This is
      // equivalent to the old relative()+split() logic without allocating a
      // relative path and vector for every audio file.
      if (const auto token = findLanguageToken(entry.path(), languageRoot)) {
        const std::string languageRootName = findLanguageRoot(entry.path(), languageRoot).value_or("");
        tokensByLanguageRoot[languageRootName].insert(*token);
      }
    }
  };
  for (const auto& entry : fs::directory_iterator(root, fs::directory_options::skip_permission_denied)) {
    if (entry.is_directory()) scanRoot(entry.path());
  }
}

std::string readFile(const fs::path& path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) return {};
  input.seekg(0, std::ios::end);
  std::string data(static_cast<std::size_t>(input.tellg()), '\0');
  input.seekg(0);
  input.read(data.data(), static_cast<std::streamsize>(data.size()));
  return data;
}

// A small streaming JSON string reader is enough here: the cracker needs game
// identifiers and paths, not a mutable object model. It decodes the escapes
// used by these ASCII identifiers and reports whether a string is an object key.
template <typename Callback>
void scanJsonStrings(std::string_view json, Callback callback) {
  for (std::size_t i = 0; i < json.size(); ++i) {
    if (json[i] != '"') continue;
    std::string value;
    for (++i; i < json.size(); ++i) {
      char ch = json[i];
      if (ch == '"') break;
      if (ch != '\\') {
        value.push_back(ch);
        continue;
      }
      if (++i >= json.size()) break;
      ch = json[i];
      switch (ch) {
        case '"': case '\\': case '/': value.push_back(ch); break;
        case 'b': value.push_back('\b'); break;
        case 'f': value.push_back('\f'); break;
        case 'n': value.push_back('\n'); break;
        case 'r': value.push_back('\r'); break;
        case 't': value.push_back('\t'); break;
        default: break; // Unicode text is irrelevant to filename reconstruction.
      }
    }
    std::size_t next = i + 1;
    while (next < json.size() && std::isspace(static_cast<unsigned char>(json[next]))) ++next;
    callback(value, next < json.size() && json[next] == ':');
  }
}

std::optional<std::uint64_t> parseHex(std::string_view value) {
  if (!isHex16(value)) return std::nullopt;
  std::uint64_t result = 0;
  for (char ch : value) {
    result <<= 4;
    if (ch >= '0' && ch <= '9') result |= static_cast<unsigned>(ch - '0');
    else result |= static_cast<unsigned>(std::tolower(static_cast<unsigned char>(ch)) - 'a' + 10);
  }
  return result;
}

std::size_t collectTargetHashes(
  const fs::path& wavRoot,
  std::unordered_set<std::uint64_t>& targetHashes,
  TargetHashesByRoot& targetHashesByRoot,
  const LanguageTokensByRoot& languageTokensByRoot
) {
  if (!fs::is_directory(wavRoot)) return 0;

  // WAV output is partitioned as <game-root>/.../<language>/<16-hex>.wav.
  // Keep hashes separated by both game root and language because one game root
  // can contain all four voice locales.
  targetHashes.reserve(300000);
  targetHashesByRoot.reserve(8);
  std::size_t scannedFiles = 0;
  std::size_t hashedFiles = 0;
  const auto scanRoot = [&](const fs::path& root, const std::string& rootName) {
    for (const auto& entry : fs::recursive_directory_iterator(root, fs::directory_options::skip_permission_denied)) {
      if (!entry.is_regular_file()) continue;
      ++scannedFiles;
      const std::string filename = entry.path().filename().string();
      if (filename.size() != 20 || filename[16] != '.'
          || (filename[17] != 'w' && filename[17] != 'W')
          || (filename[18] != 'a' && filename[18] != 'A')
          || (filename[19] != 'v' && filename[19] != 'V')) continue;
      if (const auto hash = parseHex(std::string_view(filename).substr(0, 16))) {
        const auto languageToken = findLanguageToken(entry.path(), root);
        const auto languageRoot = findLanguageRoot(entry.path(), root);
        const auto rootTokens = languageTokensByRoot.find(rootName);
        if (rootTokens == languageTokensByRoot.end()) continue;
        const auto resolveToken = [&](const std::string& languageRootName) -> std::optional<std::string> {
          const auto candidates = rootTokens->second.find(languageRootName);
          if (candidates == rootTokens->second.end() || candidates->second.size() != 1) return std::nullopt;
          return *candidates->second.begin();
        };
        const auto resolvedToken = languageToken
          ? languageToken
          : languageRoot ? resolveToken(*languageRoot) : resolveToken("");
        if (!resolvedToken) continue;
        targetHashes.insert(*hash);
        targetHashesByRoot[rootName][*resolvedToken].insert(*hash);
        ++hashedFiles;
      }
      if (scannedFiles % 100000 == 0) {
        std::cerr << "[progress] scanned " << scannedFiles << " WAV files, found " << hashedFiles << " target hashes\n";
      }
    }
  };

  for (const auto& entry : fs::directory_iterator(wavRoot, fs::directory_options::skip_permission_denied)) {
    if (entry.is_directory()) scanRoot(entry.path(), lower(entry.path().filename().string()));
  }
  return scannedFiles;
}

std::string hexOf(std::uint64_t value) {
  std::ostringstream output;
  output << std::hex << std::nouppercase << std::setw(16) << std::setfill('0') << value;
  return output.str();
}

const std::unordered_set<std::string> categoryNames = {
  "Accompany", "Activity", "Breath", "Bubble", "Chat", "ChatPlus", "Chessboard", "Cinema",
  "Clue", "Comic", "Gal", "Galgame", "Level", "Maincity", "Maincity_NPC", "Maincity_ShopNpc",
  "Message", "Ongoing", "OngoingAntique", "OngoingCinema", "OngoingLevel", "OngoingMainCity",
  "Tips", "TL", "VoiceOnly"
};

bool categoryToken(std::string_view value) {
  return categoryNames.find(std::string(value)) != categoryNames.end() || value.rfind("Ver", 0) == 0;
}

bool looksLikeVoiceSource(std::string_view value) {
  if (value.size() < 5 || value.size() > 200 || value.back() == '/') return false;
  if (std::any_of(value.begin(), value.end(), [](unsigned char ch) { return ch <= 0x20 || ch >= 0x7f; })) return false;
  if (value.rfind("VO_", 0) == 0 && value.find('/') != std::string_view::npos) return true;
  const std::size_t separator = value.find('_');
  if (separator == std::string_view::npos) return false;
  const std::string first(value.substr(0, separator));
  return categoryNames.find(first) != categoryNames.end() || first == "NPC" || first == "MainCity" || first == "Timeline";
}

std::string categoryForSource(std::string_view source) {
  const std::size_t slash = source.find_last_of('/');
  const std::string leaf = lower(std::string(slash == std::string_view::npos ? source : source.substr(slash + 1)));
  if (leaf.rfind("galgame_", 0) == 0) return "VO_Galgame";
  if (leaf.rfind("comic_", 0) == 0) return "VO_Comic";
  if (leaf.rfind("chatplus_", 0) == 0) return "VO_ChatPlus";
  if (leaf.rfind("timeline_", 0) == 0 || leaf.rfind("vo_cs", 0) == 0) return "VO_TL";
  if (leaf.rfind("bubble", 0) == 0 || leaf.rfind("vo_npc_", 0) == 0) return "VO_Bubble";
  if (leaf.rfind("cinema", 0) == 0 || leaf.rfind("ongoingcinema_", 0) == 0) return "VO_Cinema";
  if (leaf.rfind("ongoinglevel_", 0) == 0 || leaf.rfind("level_", 0) == 0) return "VO_Level";
  if (leaf.rfind("ongoing", 0) == 0) return "VO_Ongoing";
  if (leaf.rfind("chessboard_", 0) == 0) return "VO_Chessboard";
  if (leaf.rfind("accompany_", 0) == 0) return "VO_Accompany";
  if (leaf.rfind("tips_", 0) == 0) return "VO_Tips";
  return {};
}

void addAlias(std::unordered_map<std::string, std::string>& aliases, std::string value) {
  if (value.rfind("VO_", 0) == 0) value.erase(0, 3);
  if (!isIdentifier(value) || categoryToken(value)) return;
  aliases.emplace(lower(value), std::move(value));
}

void mineAliases(std::string_view value, std::unordered_map<std::string, std::string>& aliases) {
  for (const std::string& segment : split(value, '/')) {
    if (segment.rfind("VO_", 0) == 0) addAlias(aliases, segment);
  }
  const std::string low = lower(std::string(value));
  const std::size_t bank = low.find("bk_");
  const std::size_t bankEnd = bank == std::string::npos ? std::string::npos : low.find("_vo", bank + 3);
  if (bankEnd != std::string::npos) addAlias(aliases, std::string(value.substr(bank + 3, bankEnd - bank - 3)));

  // Avatar model/config identifiers often end in the internal voice alias.
  if (low.find("avatar_") != std::string::npos) {
    const std::size_t last = value.find_last_of('_');
    if (last != std::string::npos) addAlias(aliases, std::string(value.substr(last + 1)));
  }
}

void mineAvatarAliases(std::string_view value, std::unordered_set<std::string>& aliases) {
  for (std::size_t start = value.find("BK_"); start != std::string_view::npos; start = value.find("BK_", start + 3)) {
    const std::size_t end = value.find("_VO", start + 3);
    if (end == std::string_view::npos) continue;
    const std::string alias(value.substr(start + 3, end - start - 3));
    if (isIdentifier(alias) && alias != "CHR_Common") aliases.insert(alias);
  }
}

std::optional<DialogueId> parseDialogueId(const std::string& textId) {
  const std::vector<std::string> parts = split(textId, '_');
  if (parts.size() < 5 || !isDigits(parts.back()) || !isDigits(parts[parts.size() - 2]) || parts[parts.size() - 2].size() < 5) return std::nullopt;
  const std::string& category = parts[1];
  if (category != "GalGame" && category != "OngoingLevel" && category != "Ongoing" &&
      category != "OngoingMainCity" && category != "OngoingCinema" && category != "Cinema") return std::nullopt;

  std::string middle;
  for (std::size_t i = 1; i + 2 < parts.size(); ++i) {
    if (!middle.empty()) middle += '_';
    middle += parts[i];
  }
  return DialogueId{textId, category, middle, parts[parts.size() - 2], parts.back()};
}

std::vector<std::string> foldersFor(std::string_view category) {
  if (category == "GalGame") return {"VO_Galgame"};
  if (category == "OngoingLevel") return {"VO_Level", "VO_Ongoing"};
  if (category == "Ongoing" || category == "OngoingMainCity") return {"VO_Ongoing", "VO_Level"};
  if (category == "OngoingCinema") return {"VO_Cinema", "VO_Ongoing"};
  if (category == "Cinema") return {"VO_Cinema"};
  return {};
}

std::optional<Prefix> parsePrefix(const std::string& path, bool gameOwned) {
  if (path.rfind("VO_", 0) != 0 || path.back() != '/') return std::nullopt;
  const std::vector<std::string> parts = split(path, '/');
  std::string speaker;
  for (auto it = parts.rbegin(); it != parts.rend(); ++it) {
    if (it->rfind("VO_", 0) == 0 && *it != parts.front()) {
      speaker = it->substr(3);
      break;
    }
  }
  if (!isIdentifier(speaker)) return std::nullopt;
  return Prefix{path, parts.front(), speaker, gameOwned};
}

std::vector<std::string> numberForms(unsigned value) {
  std::vector<std::string> forms;
  forms.push_back(std::to_string(value));
  for (const unsigned width : {2U, 3U}) {
    std::ostringstream formatted;
    formatted << std::setw(static_cast<int>(width)) << std::setfill('0') << value;
    if (std::find(forms.begin(), forms.end(), formatted.str()) == forms.end()) forms.push_back(formatted.str());
  }
  return forms;
}

RawPrefix parseRawPrefix(const std::string& path) {
  const std::vector<std::string> parts = split(path, '/');
  std::string speaker;
  for (std::size_t index = parts.size(); index > 1; --index) {
    if (lower(parts[index - 1]).rfind("vo_", 0) == 0) { speaker = parts[index - 1].substr(3); break; }
  }
  if (speaker.empty() && !parts.empty() && lower(parts.front()) == "vo_message" && parts.size() >= 2 && isIdentifier(parts[parts.size() - 2])) {
    speaker = parts[parts.size() - 2];
  }
  return RawPrefix{path, parts.empty() ? "" : parts.front(), speaker};
}

std::uint32_t readU32(std::string_view data, std::size_t offset) {
  if (offset + 4 > data.size()) return 0;
  return static_cast<std::uint32_t>(static_cast<unsigned char>(data[offset]))
    | static_cast<std::uint32_t>(static_cast<unsigned char>(data[offset + 1])) << 8
    | static_cast<std::uint32_t>(static_cast<unsigned char>(data[offset + 2])) << 16
    | static_cast<std::uint32_t>(static_cast<unsigned char>(data[offset + 3])) << 24;
}

struct HircObject {
  unsigned char type = 0;
  std::string body;
};

std::size_t writeEventWavIndex(const fs::path& resultRoot, const fs::path& outputPath) {
  const fs::path wemRoot = resultRoot / "wem";
  const fs::path wavRoot = resultRoot / "wav";
  if (!fs::exists(wemRoot) || !fs::exists(wavRoot)) return 0;

  std::unordered_map<std::uint32_t, HircObject> objects;
  std::unordered_map<std::uint32_t, std::uint32_t> soundSources;
  for (const auto& entry : fs::recursive_directory_iterator(wemRoot)) {
    if (!entry.is_regular_file() || lower(entry.path().extension().string()) != ".bnk") continue;
    const std::string data = readFile(entry.path());
    for (std::size_t section = 0; section + 8 <= data.size();) {
      const std::uint32_t size = readU32(data, section + 4);
      const std::size_t body = section + 8;
      if (body + size > data.size()) break;
      if (data.compare(section, 4, "HIRC") == 0 && size >= 4) {
        const std::uint32_t count = readU32(data, body);
        std::size_t cursor = body + 4;
        for (std::uint32_t index = 0; index < count && cursor + 5 <= body + size; ++index) {
          const unsigned char type = static_cast<unsigned char>(data[cursor]);
          const std::uint32_t objectSize = readU32(data, cursor + 1);
          cursor += 5;
          if (cursor + objectSize > body + size || objectSize < 4) break;
          std::string objectBody = data.substr(cursor, objectSize);
          const std::uint32_t id = readU32(objectBody, 0);
          objects[id] = HircObject{type, std::move(objectBody)};
          if (type == 2 && objectSize >= 13) soundSources[id] = readU32(objects[id].body, 9);
          cursor += objectSize;
        }
      }
      section = body + size;
    }
  }

  std::unordered_map<std::uint32_t, std::set<std::uint32_t>> memo;
  std::function<std::set<std::uint32_t>(std::uint32_t, std::set<std::uint32_t>)> resolve;
  resolve = [&](std::uint32_t id, std::set<std::uint32_t> visiting) -> std::set<std::uint32_t> {
    if (const auto cached = memo.find(id); cached != memo.end()) return cached->second;
    if (!visiting.insert(id).second) return {};
    const auto found = objects.find(id);
    if (found == objects.end()) return {};
    const HircObject& object = found->second;
    std::set<std::uint32_t> sources;
    if (object.type == 2) {
      if (const auto source = soundSources.find(id); source != soundSources.end()) sources.insert(source->second);
    } else if (object.type == 3) {
      if (object.body.size() >= 10) sources = resolve(readU32(object.body, 6), visiting);
    } else if (object.type == 4) {
      if (object.body.size() >= 5) {
        const unsigned count = static_cast<unsigned char>(object.body[4]);
        if (count > 0 && count <= 100 && 5 + count * 4 <= object.body.size()) {
          for (unsigned index = 0; index < count; ++index) {
            const auto child = resolve(readU32(object.body, 5 + index * 4), visiting);
            sources.insert(child.begin(), child.end());
          }
        }
      }
    } else {
      std::vector<std::uint32_t> best;
      for (std::size_t offset = 4; offset + 4 <= object.body.size(); ++offset) {
        const std::uint32_t count = readU32(object.body, offset);
        if (count < 1 || count > 400 || offset + 4 + count * 4 > object.body.size()) continue;
        std::vector<std::uint32_t> children;
        children.reserve(count);
        bool valid = true;
        for (std::uint32_t index = 0; index < count; ++index) {
          const std::uint32_t child = readU32(object.body, offset + 4 + index * 4);
          if (objects.find(child) == objects.end()) { valid = false; break; }
          children.push_back(child);
        }
        if (valid && children.size() > best.size()) best = std::move(children);
      }
      for (const std::uint32_t childId : best) {
        const auto child = resolve(childId, visiting);
        sources.insert(child.begin(), child.end());
      }
    }
    memo[id] = sources;
    return sources;
  };

  std::unordered_map<std::string, std::string> wavById;
  for (const auto& entry : fs::recursive_directory_iterator(wavRoot)) {
    if (!entry.is_regular_file() || lower(entry.path().extension().string()) != ".wav") continue;
    const std::string stem = entry.path().stem().string();
    if (isDigits(stem)) wavById.emplace(stem, fs::relative(entry.path(), wavRoot).generic_string());
  }

  if (!outputPath.parent_path().empty()) fs::create_directories(outputPath.parent_path());
  std::ofstream output(outputPath);
  if (!output) return 0;
  std::size_t eventCount = 0;
  for (const auto& [id, object] : objects) {
    if (object.type != 4) continue;
    bool wrote = false;
    for (const std::uint32_t source : resolve(id, {})) {
      const auto wav = wavById.find(std::to_string(source));
      if (wav == wavById.end()) continue;
      output << id << '\t' << wav->second << '\n';
      wrote = true;
    }
    if (wrote) eventCount++;
  }
  return eventCount;
}

void usage(const char* executable) {
  std::cerr << "Usage: " << executable << " [<ZenlessData> <wav-root> <output.tsv> [threads]]\n";
}

} // namespace

int main(int argc, char** argv) {
  if (argc != 1 && argc != 4 && argc != 5) {
    usage(argv[0]);
    return 2;
  }
  const char* resultEnvironment = std::getenv("VOICE_RESULT_PATH");
  const fs::path resultRoot = resultEnvironment && *resultEnvironment ? fs::path(resultEnvironment) : fs::path("result");
  const fs::path dataRoot = argc >= 4 ? fs::path(argv[1]) : fs::path("ZenlessData");
  const fs::path wavRoot = argc >= 4 ? fs::path(argv[2]) : resultRoot / "wav";
  const fs::path outputPath = argc >= 4 ? fs::path(argv[3]) : fs::path("hash-matches.tsv");
  const fs::path eventOutputPath = outputPath.parent_path().empty()
    ? fs::path("event-wavs.tsv")
    : outputPath.parent_path() / "event-wavs.tsv";
  const char* threadEnvironment = std::getenv("VOICE_HASH_THREADS");
  const unsigned requestedThreads = argc == 5
    ? static_cast<unsigned>(std::max(1, std::atoi(argv[4])))
    : threadEnvironment && *threadEnvironment
      ? static_cast<unsigned>(std::max(1, std::atoi(threadEnvironment)))
      : std::thread::hardware_concurrency();
  const unsigned threadCount = std::max(1U, requestedThreads);

  LanguageTokensByRoot languageTokensByRoot;
  const auto languageStart = Clock::now();
  collectLanguageTokens(wavRoot, languageTokensByRoot);
  collectLanguageTokens(resultRoot / "wem", languageTokensByRoot);
  logTiming("scan language tokens", languageStart);

  std::unordered_set<std::uint64_t> targetHashes;
  TargetHashesByRoot targetHashesByRoot;
  const auto targetHashStart = Clock::now();
  const std::size_t scannedWavFiles = collectTargetHashes(wavRoot, targetHashes, targetHashesByRoot, languageTokensByRoot);
  logTiming("read target hashes (" + std::to_string(scannedWavFiles) + " WAV files)", targetHashStart);
  if (targetHashes.empty()) {
    std::cerr << "No 16-hex WAV filenames found under " << wavRoot << '\n';
    return 1;
  }

  std::unordered_map<std::string, std::string> aliases;
  std::unordered_set<std::string> avatarAliases;
  std::unordered_set<std::string> prefixStrings;
  std::unordered_set<std::string> sourceCandidateStrings;
  std::vector<DialogueId> dialogueIds;
  std::unordered_set<std::string> dialogueKeys;
  std::unordered_set<std::string> namingTextKeys;
  std::unordered_map<std::string, unsigned> chatSceneTakes;
  std::unordered_map<std::string, unsigned> timelineStemTakes;
  std::unordered_set<std::string> comicAssetNames;
  std::unordered_map<std::string, std::string> legacySceneNames;
  std::unordered_map<std::string, std::unordered_map<unsigned, unsigned>> legacySceneTakes;
  const auto addLegacyScene = [&](const std::string& scene, const std::vector<std::string>& parts) {
    if (scene.size() <= 8 || scene.rfind("GalGame_", 0) != 0) return;
    const std::string key = lower(scene);
    legacySceneNames.emplace(key, scene);
    std::vector<unsigned long long> numbers;
    for (const std::string& part : parts) {
      if (!isDigits(part) || part.size() > 18) continue;
      numbers.push_back(std::strtoull(part.c_str(), nullptr, 10));
    }
    if (numbers.size() < 2 || numbers.back() == 0 || numbers.back() > 999) return;
    const unsigned subTake = static_cast<unsigned>(numbers.back());
    const unsigned long long rawMain = numbers[numbers.size() - 2];
    auto& takes = legacySceneTakes[key];
    if (rawMain > 0 && rawMain <= 999) takes[static_cast<unsigned>(rawMain)] = std::max(takes[static_cast<unsigned>(rawMain)], subTake);
    const unsigned tail = static_cast<unsigned>(rawMain % 1000);
    if (tail > 0) takes[tail] = std::max(takes[tail], subTake);
  };
  const fs::path textMapRoot = dataRoot / "TextMap";
  const auto textMapStart = Clock::now();
  if (fs::exists(textMapRoot)) {
    for (const auto& entry : fs::directory_iterator(textMapRoot, fs::directory_options::skip_permission_denied)) {
      if (!entry.is_regular_file() || lower(entry.path().extension().string()) != ".json") continue;
      scanJsonStrings(readFile(entry.path()), [&](const std::string& value, bool key) {
        if (!key) return;
        if (auto parsed = parseDialogueId(value); parsed && dialogueKeys.insert(parsed->textId).second) dialogueIds.push_back(std::move(*parsed));
        if (!namingTextKeys.insert(value).second) return;
        const std::vector<std::string> parts = split(value, '_');
        if (parts.size() >= 5 && parts[1] == "Chat" && isDigits(parts[parts.size() - 2]) && isDigits(parts.back())) {
          std::string family;
          for (std::size_t index = 2; index + 2 < parts.size(); ++index) {
            if (!family.empty()) family += '_';
            family += parts[index];
          }
          const std::string key = "ChatPlus_" + family + '\t' + parts[parts.size() - 2];
          chatSceneTakes[key]++;
        }
        if (value.rfind("TL_", 0) == 0 && parts.size() >= 3 && isDigits(parts.back())) {
          const std::size_t suffix = value.rfind('_');
          if (suffix != std::string::npos && suffix > 3) {
            const std::string remainder = value.substr(3, suffix - 3);
            timelineStemTakes["Timeline_" + remainder]++;
            timelineStemTakes["Vo_" + remainder]++;
          }
        }
        if (parts.size() >= 3 && parts.front() == "GalGame") {
          std::size_t end = 1;
          while (end < parts.size() && !isDigits(parts[end]) && parts[end].find_first_of("0123456789") == std::string::npos) ++end;
          // Chapter010 and similar scene tokens contain digits but are part of the
          // task name, not the local sequence.
          if (end == 1 && parts.size() > 1) end = 2;
          std::string scene;
          for (std::size_t i = 0; i < end; ++i) { if (i) scene += '_'; scene += parts[i]; }
          addLegacyScene(scene, parts);
        }
        for (const std::string& part : parts) {
          if (part.rfind("Chapter", 0) == 0 && part.size() > 7) addLegacyScene("GalGame_" + part, parts);
        }
      });
    }
  }
  logTiming("read TextMap", textMapStart);

  const auto dataScanStart = Clock::now();
  for (const auto& entry : fs::recursive_directory_iterator(dataRoot)) {
    if (!entry.is_regular_file() || lower(entry.path().extension().string()) != ".json") continue;
    const std::string relativePath = fs::relative(entry.path(), dataRoot).generic_string();
    if (relativePath.rfind("TextMap/", 0) == 0) continue;
    const std::string data = readFile(entry.path());
    scanJsonStrings(data, [&](const std::string& value, bool) {
      mineAliases(value, aliases);
      mineAvatarAliases(value, avatarAliases);
      if (value.rfind("VO_", 0) == 0 && !value.empty() && value.back() == '/') prefixStrings.insert(value);
      if (looksLikeVoiceSource(value)) sourceCandidateStrings.insert(value);
      const std::string normalized = lower(value);
      const std::string comicMarker = "data/scriptconfig/comic/";
      const std::size_t comic = normalized.find(comicMarker);
      if (comic != std::string::npos && normalized.size() > comic + comicMarker.size() + 6 && normalized.substr(normalized.size() - 6) == ".asset") {
        const std::size_t start = comic + comicMarker.size();
        const std::size_t slash = value.find_last_of("/\\");
        if (slash == std::string::npos || slash < start) comicAssetNames.insert(value.substr(start, value.size() - start - 6));
        else comicAssetNames.insert(value.substr(slash + 1, value.size() - slash - 7));
      }
    });
  }
  logTiming("scan game data", dataScanStart);

  const auto candidateStart = Clock::now();
  std::vector<Prefix> prefixes;
  std::unordered_set<std::string> prefixKeys;
  for (const std::string& path : prefixStrings) {
    if (auto prefix = parsePrefix(path, true)) {
      prefixKeys.insert(lower(prefix->path));
      addAlias(aliases, prefix->speaker);
      prefixes.push_back(std::move(*prefix));
    }
  }

  std::vector<SourceCandidate> sourceCandidates;
  sourceCandidates.reserve(sourceCandidateStrings.size() + 40000);
  std::unordered_set<std::string> sourceCandidateKeys;
  const auto voidBlocks = readNumberArray(readFile(dataRoot / "Data" / "_unsorted" / "VoiceData.json"), "voidBlocks");
  for (const std::string& source : sourceCandidateStrings) {
    const std::size_t slash = source.find_last_of('/');
    const std::string_view leaf = slash == std::string::npos ? std::string_view(source) : std::string_view(source).substr(slash + 1);
    const std::string category = categoryForSource(source);
    const bool verifiedVoidBlock = slash == std::string::npos && voidBlocks.find(fnv32(leaf)) != voidBlocks.end();
    if (slash == std::string::npos && category.empty() && !verifiedVoidBlock) continue;
    if (sourceCandidateKeys.insert(lower(source)).second) {
      sourceCandidates.push_back(SourceCandidate{source, "", verifiedVoidBlock ? "" : category});
    }
  }

  std::size_t galScriptSourceCount = 0;
  const char* galScriptEnvironment = std::getenv("VOICE_GALSCRIPT_DICTIONARY");
  const fs::path galScriptPath = galScriptEnvironment && *galScriptEnvironment
    ? fs::path(galScriptEnvironment)
    : resultRoot / "galgame-perform-links.tsv";
  {
    std::ifstream input(galScriptPath);
    std::string line;
    while (std::getline(input, line)) {
      if (line.empty() || line[0] == '#') continue;
      const std::size_t tab = line.find('\t');
      const std::string source = line.substr(0, tab);
      if (lower(source).rfind("galgame_", 0) != 0) continue;
      if (!sourceCandidateKeys.insert(lower(source)).second) continue;
      sourceCandidates.push_back(SourceCandidate{source, "", "VO_Galgame"});
      galScriptSourceCount++;
    }
  }

  std::vector<RawPrefix> rawPrefixes;
  rawPrefixes.reserve(prefixStrings.size());
  for (const std::string& path : prefixStrings) rawPrefixes.push_back(parseRawPrefix(path));

  std::unordered_map<std::string, std::vector<std::string>> patternKeywords;
  {
    const fs::path patternPath = fs::absolute(dataRoot).parent_path() / "hash-cracker" / "author-patterns.tsv";
    std::ifstream input(patternPath);
    std::string line;
    while (std::getline(input, line)) {
      if (line.empty() || line[0] == '#') continue;
      const std::size_t first = line.find('\t');
      const std::size_t second = first == std::string::npos ? std::string::npos : line.find('\t', first + 1);
      if (first == std::string::npos || second == std::string::npos) continue;
      const std::string key = line.substr(0, first) + ':' + line.substr(first + 1, second - first - 1);
      patternKeywords[key] = split(line.substr(second + 1), ',');
    }
  }
  logTiming("prepare crack candidates", candidateStart);

  std::vector<std::string> legacyGalGameScenes;
  {
    std::unordered_set<std::string> seen;
    for (const DialogueId& dialogue : dialogueIds) {
      if (dialogue.category == "GalGame") addLegacyScene(dialogue.middle, {dialogue.contentId, dialogue.lineIndex});
    }
    for (const auto& [key, scene] : legacySceneNames) if (seen.insert(key).second) legacyGalGameScenes.push_back(scene);
  }

  std::vector<Language> languages;
  for (const auto& [root, tokens] : targetHashesByRoot) {
    for (const auto& [token, tokenTargets] : tokens) {
      if (tokenTargets.empty()) continue;
      Language language;
      language.root = root;
      language.token = token;
      // The stored hash is equivalent to FNV-1 of <language>/Ex/<source>.wem.
      // Prefixing the source path with the already-folded <language>/ex/ state
      // avoids the old Chinese-only opaque constant and keeps all locales exact.
      language.baseState = fold(fnvOffset, language.token + "/ex/", true);
      language.targetHashes = tokenTargets;
      for (const Prefix& prefix : prefixes) {
        const std::uint64_t state = fold(language.baseState, prefix.path, true);
        language.prefixesByCategory[prefix.category].push_back(HashedPrefix{&prefix, state});
      }
      languages.push_back(std::move(language));
    }
  }
  std::sort(languages.begin(), languages.end(), [](const Language& left, const Language& right) {
    if (left.root != right.root) return left.root < right.root;
    return left.token < right.token;
  });

  std::cerr << targetHashes.size() << " target hashes across " << languages.size() << " languages, " << aliases.size() << " game aliases, "
            << dialogueIds.size() << " dialogue IDs, " << sourceCandidates.size() << " direct sources, "
            << galScriptSourceCount << " GalScript dictionary sources, " << patternKeywords.size() << " author pattern groups, " << prefixes.size() << " candidate prefixes, "
            << threadCount << " threads\n";

  std::unordered_map<std::string, std::vector<std::string>> foldersByCategory;
  for (const DialogueId& dialogue : dialogueIds) foldersByCategory.emplace(dialogue.category, foldersFor(dialogue.category));

  // Candidate generators repeatedly use the same decimal forms. Keep these
  // immutable so the hot crack loops do not allocate and format them again for
  // every prefix, scene, language, and take.
  std::vector<std::vector<std::string>> numberFormsCache(1000);
  for (unsigned value = 1; value < numberFormsCache.size(); ++value) numberFormsCache[value] = numberForms(value);
  const auto& formsFor = [&](unsigned value) -> const std::vector<std::string>& {
    return numberFormsCache[value];
  };

  std::atomic<std::size_t> next{0};
  std::mutex matchesMutex;
  std::vector<Match> matches;
  auto worker = [&] {
    std::vector<Match> local;
    while (true) {
      const std::size_t index = next.fetch_add(1, std::memory_order_relaxed);
      if (index >= dialogueIds.size()) break;
      const DialogueId& dialogue = dialogueIds[index];
      const auto folders = foldersByCategory.find(dialogue.category);
      if (folders == foldersByCategory.end()) continue;
      for (const Language& language : languages) {
        for (const std::string& folder : folders->second) {
          const auto found = language.prefixesByCategory.find(folder);
          if (found == language.prefixesByCategory.end()) continue;
          for (const HashedPrefix& hashedPrefix : found->second) {
            const Prefix& prefix = *hashedPrefix.prefix;
            const std::string leaf = dialogue.middle + '_' + prefix.speaker + '_' + dialogue.contentId + '_' + dialogue.lineIndex + ".wem";
            const std::uint64_t hash = fold(hashedPrefix.state, leaf, true);
            if (language.targetHashes.find(hash) != language.targetHashes.end()) local.push_back(Match{hash, prefix.speaker, prefix.path + leaf.substr(0, leaf.size() - 4), ""});
          }
        }
      }
    }
    std::lock_guard<std::mutex> lock(matchesMutex);
    matches.insert(matches.end(), std::make_move_iterator(local.begin()), std::make_move_iterator(local.end()));
  };

  std::vector<std::thread> threads;
  const auto dialogueCrackStart = Clock::now();
  threads.reserve(threadCount);
  for (unsigned i = 0; i < threadCount; ++i) threads.emplace_back(worker);
  for (std::thread& thread : threads) thread.join();
  logTiming("crack dialogue IDs (" + std::to_string(dialogueIds.size()) + ")", dialogueCrackStart);

  // Legacy GalGame files do not encode a content id. Their final numbers are a
  // per-speaker local sequence (and sometimes a sub-take), so they cannot be
  // bound to a specific subtitle safely. They can still recover an exact source
  // filename and speaker: brute game task/scene stems x game-owned Wwise
  // prefixes x the bounded local sequence, then retain only real 64-bit hits.
  const auto legacyCrackStart = Clock::now();
  next.store(0, std::memory_order_relaxed);
  threads.clear();
  auto legacyWorker = [&] {
    std::vector<Match> local;
    while (true) {
      const std::size_t index = next.fetch_add(1, std::memory_order_relaxed);
      if (index >= legacyGalGameScenes.size()) break;
      const std::string& scene = legacyGalGameScenes[index];
      const auto takeDictionary = legacySceneTakes.find(lower(scene));
      if (takeDictionary == legacySceneTakes.end()) continue;
      for (const Language& language : languages) {
        const auto found = language.prefixesByCategory.find("VO_Galgame");
        if (found == language.prefixesByCategory.end()) continue;
        for (const HashedPrefix& hashedPrefix : found->second) {
          const Prefix& prefix = *hashedPrefix.prefix;
          if (!prefix.gameOwned) continue;
          std::uint64_t base = fold(hashedPrefix.state, scene, true);
          base = fold(base, "_");
          base = fold(base, prefix.speaker, true);
          base = fold(base, "_");
          for (const auto& [take, maxSubTake] : takeDictionary->second) {
            for (const std::string& takeForm : formsFor(take)) {
              const std::uint64_t takeState = fold(base, takeForm);
              const std::uint64_t hash = fold(takeState, ".wem");
              if (language.targetHashes.find(hash) != language.targetHashes.end()) {
                local.push_back(Match{hash, prefix.speaker, prefix.path + scene + '_' + prefix.speaker + '_' + takeForm, ""});
              }
              const std::uint64_t subState = fold(takeState, "_");
              for (unsigned subTake = 1; subTake <= maxSubTake; ++subTake) {
                for (const std::string& subForm : formsFor(subTake)) {
                  const std::uint64_t subHash = fold(fold(subState, subForm), ".wem");
                  if (language.targetHashes.find(subHash) != language.targetHashes.end()) local.push_back(Match{subHash, prefix.speaker, prefix.path + scene + '_' + prefix.speaker + '_' + takeForm + '_' + subForm, ""});
                }
              }
            }
          }
        }
      }
    }
    std::lock_guard<std::mutex> lock(matchesMutex);
    matches.insert(matches.end(), std::make_move_iterator(local.begin()), std::make_move_iterator(local.end()));
  };
  for (unsigned i = 0; i < threadCount; ++i) threads.emplace_back(legacyWorker);
  for (std::thread& thread : threads) thread.join();
  logTiming("crack legacy GalGame scenes (" + std::to_string(legacyGalGameScenes.size()) + ")", legacyCrackStart);

  // Direct source names are already mined from ZenlessData config rows. Hash
  // them here too, so update.ts never repeats the expensive bare-leaf x prefix
  // product with JavaScript BigInt arithmetic.
  const auto sourceCrackStart = Clock::now();
  next.store(0, std::memory_order_relaxed);
  threads.clear();
  auto sourceWorker = [&] {
    std::vector<Match> local;
    while (true) {
      const std::size_t index = next.fetch_add(1, std::memory_order_relaxed);
      if (index >= sourceCandidates.size()) break;
      const SourceCandidate& candidate = sourceCandidates[index];
      const std::string filename = candidate.source + ".wem";
      for (const Language& language : languages) {
        if (candidate.source.find('/') != std::string::npos) {
          const std::uint64_t hash = fold(language.baseState, filename, true);
          if (language.targetHashes.find(hash) != language.targetHashes.end()) local.push_back(Match{hash, candidate.speaker, candidate.source, candidate.source});
          continue;
        }
        const auto tryPrefixes = [&](const std::vector<HashedPrefix>& hashedPrefixes) {
          for (const HashedPrefix& hashedPrefix : hashedPrefixes) {
            const Prefix& prefix = *hashedPrefix.prefix;
            if (!prefix.gameOwned) continue;
            const std::uint64_t hash = fold(hashedPrefix.state, filename, true);
            if (language.targetHashes.find(hash) == language.targetHashes.end()) continue;
            local.push_back(Match{hash, candidate.speaker.empty() ? prefix.speaker : candidate.speaker, prefix.path + candidate.source, candidate.source});
          }
        };
        if (!candidate.category.empty()) {
          const auto found = language.prefixesByCategory.find(candidate.category);
          if (found != language.prefixesByCategory.end()) tryPrefixes(found->second);
        } else {
          for (const auto& [_, hashedPrefixes] : language.prefixesByCategory) tryPrefixes(hashedPrefixes);
        }
      }
    }
    std::lock_guard<std::mutex> lock(matchesMutex);
    matches.insert(matches.end(), std::make_move_iterator(local.begin()), std::make_move_iterator(local.end()));
  };
  for (unsigned i = 0; i < threadCount; ++i) threads.emplace_back(sourceWorker);
  for (std::thread& thread : threads) thread.join();
  logTiming("crack direct sources (" + std::to_string(sourceCandidates.size()) + ")", sourceCrackStart);

  std::vector<std::string> allAliases;
  allAliases.reserve(aliases.size());
  for (const auto& [_, alias] : aliases) allAliases.push_back(alias);
  std::sort(allAliases.begin(), allAliases.end());
  allAliases.erase(std::unique(allAliases.begin(), allAliases.end(), [](const std::string& left, const std::string& right) {
    return lower(left) == lower(right);
  }), allAliases.end());

  std::vector<std::string> galGameSceneAliases(avatarAliases.begin(), avatarAliases.end());
  for (const RawPrefix& prefix : rawPrefixes) {
    if (lower(prefix.category) == "vo_galgame" && !prefix.speaker.empty()) galGameSceneAliases.push_back(prefix.speaker);
  }
  std::sort(galGameSceneAliases.begin(), galGameSceneAliases.end());
  galGameSceneAliases.erase(std::unique(galGameSceneAliases.begin(), galGameSceneAliases.end(), [](const std::string& left, const std::string& right) {
    return lower(left) == lower(right);
  }), galGameSceneAliases.end());

  std::vector<std::string> cinemaContentIds;
  for (const DialogueId& dialogue : dialogueIds) {
    if (dialogue.category == "Cinema" && isDigits(dialogue.contentId)) cinemaContentIds.push_back(dialogue.contentId);
  }
  std::sort(cinemaContentIds.begin(), cinemaContentIds.end());
  cinemaContentIds.erase(std::unique(cinemaContentIds.begin(), cinemaContentIds.end()), cinemaContentIds.end());

  std::unordered_map<std::string, LocalScene> localSceneMap;
  for (const DialogueId& dialogue : dialogueIds) {
    if (dialogue.category == "GalGame") continue;
    const std::string key = dialogue.category + '\t' + dialogue.middle + '\t' + dialogue.contentId;
    auto& scene = localSceneMap[key];
    scene.category = dialogue.category;
    scene.stem = dialogue.middle;
    scene.contentId = dialogue.contentId;
    scene.maxTake++;
  }
  std::unordered_map<std::string, std::vector<LocalScene>> localScenesByFolder;
  for (const auto& [_, scene] : localSceneMap) {
    LocalScene bounded = scene;
    bounded.maxTake = std::min(300U, std::max(3U, bounded.maxTake));
    for (const std::string& folder : foldersFor(scene.category)) localScenesByFolder[lower(folder)].push_back(bounded);
  }

  std::vector<LocalScene> chatScenes;
  chatScenes.reserve(chatSceneTakes.size());
  for (const auto& [key, count] : chatSceneTakes) {
    const std::size_t tab = key.find('\t');
    if (tab == std::string::npos) continue;
    chatScenes.push_back(LocalScene{"Chat", key.substr(0, tab), key.substr(tab + 1), std::min(200U, std::max(3U, count))});
  }
  std::vector<NumberedStem> timelineStems;
  timelineStems.reserve(timelineStemTakes.size());
  for (const auto& [stem, count] : timelineStemTakes) timelineStems.push_back(NumberedStem{stem, std::min(100U, std::max(3U, count))});

  std::unordered_set<std::string> comicSceneSet;
  for (const std::string& asset : comicAssetNames) {
    comicSceneSet.insert(asset);
    if (asset.size() > 2 && (asset[0] == 'C' || asset[0] == 'c') && std::isdigit(static_cast<unsigned char>(asset[1]))) {
      std::size_t end = 1;
      while (end < asset.size() && std::isdigit(static_cast<unsigned char>(asset[end]))) ++end;
      const unsigned chapter = static_cast<unsigned>(std::strtoul(asset.substr(1, end - 1).c_str(), nullptr, 10));
      if (chapter <= 5) comicSceneSet.insert("Chapter" + std::to_string(chapter) + asset.substr(end));
    }
    const std::size_t marker = asset.find("00_");
    if (marker != std::string::npos && marker > 0 && std::all_of(asset.begin(), asset.begin() + static_cast<std::ptrdiff_t>(marker), [](unsigned char ch) { return std::isalpha(ch) != 0; })) {
      comicSceneSet.insert("Chapter" + asset.substr(0, marker) + asset.substr(marker + 2));
    }
  }
  std::vector<std::string> comicScenes(comicSceneSet.begin(), comicSceneSet.end());

  const auto patternCrackStart = Clock::now();
  next.store(0, std::memory_order_relaxed);
  threads.clear();
  auto patternWorker = [&] {
    std::vector<Match> local;
    const auto matchSource = [&](const std::string& source, const std::string& speaker) {
      for (const Language& language : languages) {
        const std::uint64_t hash = fold(fold(language.baseState, source, true), ".wem");
        if (language.targetHashes.find(hash) != language.targetHashes.end()) local.push_back(Match{hash, speaker, source, ""});
      }
    };
    const auto emitTakes = [&](const std::string& stem, const std::string& speaker, unsigned maxTake, unsigned maxSubTake) {
      struct StemState {
        const Language* language;
        std::uint64_t state;
      };
      std::vector<StemState> stemStates;
      stemStates.reserve(languages.size());
      for (const Language& language : languages) {
        stemStates.push_back(StemState{&language, fold(fold(language.baseState, stem, true), "_")});
      }
      for (unsigned take = 1; take <= maxTake; ++take) {
        for (const std::string& takeForm : formsFor(take)) {
          for (const StemState& stemState : stemStates) {
            const std::uint64_t takeState = fold(stemState.state, takeForm);
            const std::uint64_t hash = fold(takeState, ".wem");
            if (stemState.language->targetHashes.find(hash) != stemState.language->targetHashes.end()) {
              local.push_back(Match{hash, speaker, stem + '_' + takeForm, ""});
            }
            const std::uint64_t subTakeState = fold(takeState, "_");
            for (unsigned subTake = 1; subTake <= maxSubTake; ++subTake) {
              for (const std::string& subForm : formsFor(subTake)) {
                const std::uint64_t hash = fold(fold(subTakeState, subForm), ".wem");
                if (stemState.language->targetHashes.find(hash) != stemState.language->targetHashes.end()) {
                  local.push_back(Match{hash, speaker, stem + '_' + takeForm + '_' + subForm, ""});
                }
              }
            }
          }
        }
      }
    };
    const auto& accompanyActions = patternKeywords["actions:Accompany"];
    const auto& breathEmotions = patternKeywords["emotions:Breath"];
    const auto& breathArchetypes = patternKeywords["archetypes:Breath"];
    const auto& npcAges = patternKeywords["ages:NPC"];
    const auto& npcRoleBases = patternKeywords["role-bases:NPC"];
    const auto& npcRolePrefixes = patternKeywords["role-prefixes:NPC"];
    const auto& npcRoleSuffixes = patternKeywords["role-suffixes:NPC"];
    const auto& galFamilies = patternKeywords["families:GalGame"];
    const auto& galCommon = patternKeywords["common-speakers:GalGame"];
    const auto& galNumberedChapters = patternKeywords["numbered-chapters:GalGame"];
    const auto& galSpecialScenes = patternKeywords["special-scenes:GalGame"];
    const auto& comicChapters = patternKeywords["chapters:Comic"];
    const auto& chessRanks = patternKeywords["ranks:Chessboard"];
    const auto& tipsActions = patternKeywords["actions:Tips"];
    const auto& bubbleActions = patternKeywords["actions:Bubble"];
    std::vector<std::string> npcRoles = npcRoleBases;
    for (const std::string& base : npcRoleBases) for (const std::string& suffix : npcRoleSuffixes) npcRoles.push_back(base + suffix);
    for (const std::string& modifier : npcRolePrefixes) for (const std::string& base : npcRoleBases) npcRoles.push_back(modifier + base);
    for (const std::string& modifier : npcRolePrefixes) for (const std::string& base : npcRoleBases) for (const std::string& suffix : npcRoleSuffixes) npcRoles.push_back(modifier + base + suffix);
    for (const std::string& left : galCommon) for (const std::string& right : galCommon) if (lower(left) != lower(right)) npcRoles.push_back(left + right);
    while (true) {
      const std::size_t index = next.fetch_add(1, std::memory_order_relaxed);
      if (index >= rawPrefixes.size()) break;
      const RawPrefix& prefix = rawPrefixes[index];
      const std::string category = lower(prefix.category);

      if (!prefix.speaker.empty()) {
        const auto localScenes = localScenesByFolder.find(category);
        if (localScenes != localScenesByFolder.end()) for (const LocalScene& scene : localScenes->second) {
          emitTakes(prefix.path + scene.stem + '_' + prefix.speaker + '_' + scene.contentId, prefix.speaker, scene.maxTake, 0);
          emitTakes(prefix.path + scene.stem + '_' + scene.contentId + '_' + prefix.speaker, prefix.speaker, scene.maxTake, 0);
        }
      }

      if (category == "vo_accompany" && !prefix.speaker.empty()) {
        for (const std::string& action : accompanyActions) emitTakes(prefix.path + "Accompany_" + prefix.speaker + '_' + action, prefix.speaker, 3, 0);
        for (unsigned content = 1; content <= 60; ++content) {
          const std::string contentId = std::string("521431") + (content < 10 ? "00" : content < 100 ? "0" : "") + std::to_string(content);
          emitTakes(prefix.path + "OngoingMainCityPartner_Partner" + prefix.speaker + '_' + prefix.speaker + '_' + contentId, prefix.speaker, 3, 0);
        }
      } else if (category == "vo_breath") {
        const auto emitBreath = [&](const std::string& speaker) {
          for (const std::string& emotion : breathEmotions) emitTakes(prefix.path + "Breath_" + speaker + '_' + emotion, speaker, 3, 0);
        };
        if (prefix.speaker.empty()) {
          for (const std::string& speaker : allAliases) emitBreath(speaker);
          for (const std::string& gender : {"Female", "Male"}) for (unsigned size = 1; size <= 3; ++size) for (char voice = 'A'; voice <= 'C'; ++voice) {
            const std::string speaker = "NPC_" + gender + "Size0" + std::to_string(size) + "_Voice" + voice;
            emitBreath(speaker);
          }
          for (const std::string& age : npcAges) for (char voice = 'A'; voice <= 'C'; ++voice) emitBreath("NPC_" + age + "_Voice" + voice);
          for (const std::string& speaker : breathArchetypes) emitBreath(speaker);
        }
        else emitBreath(prefix.speaker);
      } else if (category == "vo_galgame" && !prefix.speaker.empty()) {
        const bool commonSpeaker = std::any_of(galCommon.begin(), galCommon.end(), [&](const std::string& value) { return lower(value) == lower(prefix.speaker); });
        for (const std::string& scene : galGameSceneAliases) {
          const bool sameSpeaker = lower(scene) == lower(prefix.speaker);
          if (!sameSpeaker && !commonSpeaker) continue;
          for (const std::string& family : galFamilies) {
            if (family == "Chapter") {
              for (const std::string& variant : {"", "1", "2", "3"}) {
                emitTakes(prefix.path + "GalGame_Chapter" + scene + variant + '_' + prefix.speaker, prefix.speaker, 300, sameSpeaker ? 15 : 0);
              }
            } else {
              emitTakes(prefix.path + "GalGame_" + family + scene + '_' + prefix.speaker, prefix.speaker, 600, sameSpeaker ? 35 : 0);
            }
          }
        }
        for (const std::string& chapter : galNumberedChapters) {
          emitTakes(prefix.path + "GalGame_Chapter" + chapter + '_' + prefix.speaker, prefix.speaker, 300, 10);
          if (commonSpeaker) for (const std::string& role : npcRoles) {
            emitTakes(prefix.path + "GalGame_Chapter" + chapter + '_' + role, role, 300, 10);
          }
        }
        for (const std::string& scene : galSpecialScenes) {
          emitTakes(prefix.path + "GalGame_" + scene + '_' + prefix.speaker, prefix.speaker, 300, 10);
        }
      } else if (category == "vo_comic" && !prefix.speaker.empty()) {
        const std::string folderSpeaker = lower(prefix.speaker);
        const bool genericFolder = folderSpeaker == "npc" || folderSpeaker == "subordinate" || folderSpeaker == "effect";
        std::vector<std::string> leafSpeakers{prefix.speaker};
        if (genericFolder) {
          leafSpeakers = allAliases;
          leafSpeakers.insert(leafSpeakers.end(), npcRoles.begin(), npcRoles.end());
        }
        for (const std::string& leafSpeaker : leafSpeakers) for (const std::string& chapter : comicChapters) {
          emitTakes(prefix.path + "Comic_Chapter" + chapter + '_' + leafSpeaker, leafSpeaker, 200, genericFolder ? 3 : 10);
        }
        for (const std::string& leafSpeaker : leafSpeakers) for (const std::string& scene : comicScenes) {
          emitTakes(prefix.path + "Comic_" + scene + '_' + leafSpeaker, leafSpeaker, 32, genericFolder ? 3 : 0);
        }
        for (const std::string& leafSpeaker : leafSpeakers) for (const std::string& scene : galSpecialScenes) for (unsigned section = 1; section <= 8; ++section) {
          emitTakes(prefix.path + "Comic_" + scene + '_' + formsFor(section)[1] + '_' + leafSpeaker, leafSpeaker, 32, 0);
        }
      } else if (category == "vo_chessboard" && !prefix.speaker.empty()) {
        emitTakes(prefix.path + "Chessboard_Limbo_CommonAvatar_" + prefix.speaker, prefix.speaker, 300, 3);
        for (const std::string& chapter : comicChapters) for (const std::string& rank : chessRanks) for (unsigned rankIndex = 1; rankIndex <= 4; ++rankIndex) {
          emitTakes(prefix.path + "Chessboard_Chapter" + chapter + '_' + rank + std::to_string(rankIndex) + '_' + prefix.speaker, prefix.speaker, 100, 3);
          for (unsigned section = 1; section <= 5; ++section) {
            emitTakes(prefix.path + "Chessboard_Chapter" + chapter + '_' + std::to_string(section) + '_' + rank + std::to_string(rankIndex) + '_' + prefix.speaker, prefix.speaker, 100, 3);
            emitTakes(prefix.path + "Chessboard_Chapter" + chapter + '_' + rank + std::to_string(rankIndex) + '_' + std::to_string(section) + '_' + prefix.speaker, prefix.speaker, 100, 3);
          }
        }
        for (const std::string& companion : galGameSceneAliases) for (unsigned variant = 1; variant <= 3; ++variant) {
          emitTakes(prefix.path + "Chessboard_Companion_" + companion + std::to_string(variant) + '_' + prefix.speaker, prefix.speaker, 250, 3);
        }
        emitTakes(prefix.path + "Chessboard_Limbo_AvatarCall_" + prefix.speaker, prefix.speaker, 3, 0);
      } else if (category == "vo_cinema") {
        if (prefix.speaker.empty()) {
          for (unsigned film = 1; film <= 20; ++film) emitTakes(prefix.path + "VOID_CinemaFilm_" + std::to_string(film), "", 5, 0);
        } else {
          emitTakes(prefix.path + "CinemaBreath_Cinema_" + prefix.speaker, prefix.speaker, 8, 0);
          emitTakes(prefix.path + "Cinema_" + prefix.speaker, prefix.speaker, 8, 0);
          for (const std::string& contentId : cinemaContentIds) emitTakes(prefix.path + "CinemaBreath_Cinema_" + prefix.speaker + '_' + contentId, prefix.speaker, 5, 0);
          for (const std::string& action : accompanyActions) {
            emitTakes(prefix.path + "Cinema_" + prefix.speaker + '_' + action, prefix.speaker, 3, 0);
            emitTakes(prefix.path + "Cinema_NPC_MainCity_" + prefix.speaker + '_' + action, prefix.speaker, 3, 0);
          }
          for (unsigned scene = 1; scene <= 20; ++scene) for (unsigned breath = 1; breath <= 4; ++breath) {
            std::ostringstream breathName;
            breathName << "Cinema_" << prefix.speaker << '_' << scene << "_Breath" << std::setw(2) << std::setfill('0') << breath;
            matchSource(prefix.path + breathName.str(), prefix.speaker);
            matchSource(prefix.path + "CinemaBreath_" + breathName.str(), prefix.speaker);
          }
        }
      } else if (category == "vo_tips" && !prefix.speaker.empty()) {
        for (const std::string& action : tipsActions) {
          matchSource(prefix.path + "Tips_" + prefix.speaker + '_' + action, prefix.speaker);
          emitTakes(prefix.path + "Tips_" + prefix.speaker + '_' + action, prefix.speaker, 3, 0);
        }
      } else if (category == "vo_bubble" && !prefix.speaker.empty()) {
        for (const std::string& action : bubbleActions) {
          matchSource(prefix.path + "Bubble_" + prefix.speaker + '_' + action, prefix.speaker);
          emitTakes(prefix.path + "Bubble_" + prefix.speaker + '_' + action, prefix.speaker, 3, 0);
        }
      } else if (category == "vo_chatplus" && !prefix.speaker.empty()) {
        for (const LocalScene& scene : chatScenes) {
          emitTakes(prefix.path + scene.stem + '_' + prefix.speaker + '_' + scene.contentId, prefix.speaker, scene.maxTake, 0);
        }
      } else if (category == "vo_tl" && !prefix.speaker.empty()) {
        for (const NumberedStem& stem : timelineStems) {
          emitTakes(prefix.path + stem.stem + '_' + prefix.speaker, prefix.speaker, stem.maxTake, 0);
        }
      } else if (category == "vo_message" && !prefix.speaker.empty()) {
        emitTakes(prefix.path + "Message_SayHello_" + prefix.speaker, prefix.speaker, 3, 0);
        emitTakes(prefix.path + "Message_" + prefix.speaker, prefix.speaker, 3, 0);
      }
    }
    std::lock_guard<std::mutex> lock(matchesMutex);
    matches.insert(matches.end(), std::make_move_iterator(local.begin()), std::make_move_iterator(local.end()));
  };
  for (unsigned i = 0; i < threadCount; ++i) threads.emplace_back(patternWorker);
  for (std::thread& thread : threads) thread.join();
  logTiming("crack author naming patterns (" + std::to_string(rawPrefixes.size()) + " prefixes)", patternCrackStart);

  const auto mergeStart = Clock::now();
  std::sort(matches.begin(), matches.end(), [](const Match& left, const Match& right) {
    if (left.hash != right.hash) return left.hash < right.hash;
    const std::string leftSource = lower(left.source);
    const std::string rightSource = lower(right.source);
    if (leftSource != rightSource) return leftSource < rightSource;
    if (left.source != right.source) return left.source < right.source;
    if (left.sourceKey != right.sourceKey) return left.sourceKey < right.sourceKey;
    return left.speaker < right.speaker;
  });
  std::vector<Match> mergedMatches;
  mergedMatches.reserve(matches.size());
  for (Match& match : matches) {
    if (!mergedMatches.empty() && mergedMatches.back().hash == match.hash && lower(mergedMatches.back().source) == lower(match.source)) {
      Match& merged = mergedMatches.back();
      if (merged.speaker.empty()) merged.speaker = std::move(match.speaker);
      if (merged.sourceKey.empty()) merged.sourceKey = std::move(match.sourceKey);
      continue;
    }
    mergedMatches.push_back(std::move(match));
  }
  matches = std::move(mergedMatches);
  logTiming("sort and merge matches", mergeStart);

  const auto outputStart = Clock::now();
  if (!outputPath.parent_path().empty()) fs::create_directories(outputPath.parent_path());
  std::ofstream output(outputPath);
  if (!output) {
    std::cerr << "Cannot write " << outputPath << '\n';
    return 1;
  }
  for (const Match& match : matches) output << hexOf(match.hash) << '\t' << match.speaker << '\t' << match.source << '\t' << match.sourceKey << '\n';
  logTiming("write hash matches", outputStart);
  std::cout << "Cracked " << matches.size() << " exact filename matches into " << outputPath << '\n';
  const auto eventIndexStart = Clock::now();
  const std::size_t eventCount = writeEventWavIndex(resultRoot, eventOutputPath);
  logTiming("write event WAV index (" + std::to_string(eventCount) + " events)", eventIndexStart);
  std::cout << "Indexed " << eventCount << " BNK events into " << eventOutputPath << '\n';
  return 0;
}
