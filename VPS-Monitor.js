/**
 * Surge VPS Monitor
 * 聚合展示多台 VPS 的流量、内存、磁盘、重置日和到期日。
 *
 * 支持：
 *   1. BandwagonHost / KiwiVM（provider=bwg）
 *   2. V.PS / vps.hosting（provider=vps，自动发现账户内服务器）
 *   3. 标准化 JSON 接口（provider=json）
 *   4. 旧版单台 BWG 参数：veid=...&apikey=...&title=...
 *
 * 多台服务器参数（字段中的特殊字符请先做 URL 编码）：
 *   server1=名称|bwg|VEID|API_KEY|YYYY-MM-DD
 *   server2=V.PS|vps|ACCOUNT_EMAIL|ACCOUNT_PASSWORD|
 *   server3=名称|json|URL|BEARER_TOKEN|YYYY-MM-DD
 */

(function () {
  "use strict";

  var args = parseArgs(typeof $argument === "string" ? $argument : "");
  var settings = {
    title: args.panel_title || args.panelTitle || "VPS 总览",
    icon: args.icon || "server.rack",
    requestTimeout: clampNumber(args.request_timeout || args.requestTimeout, 2, 10, 6),
    showDetails: parseBoolean(args.detail, true),
    showBar: parseBoolean(args.bar, true)
  };
  var servers = parseServers(args);

  if (!servers.length) {
    finishPanel({
      title: settings.title,
      content: "未找到服务器配置\n请添加 BWG、V.PS 或 JSON 数据源",
      icon: settings.icon,
      "icon-color": "#FF453A"
    });
    return;
  }

  var pending = servers.length;
  var resultGroups = new Array(servers.length);
  var completed = false;

  servers.forEach(function (server, index) {
    fetchServer(server, function (result) {
      if (completed) return;
      resultGroups[index] = Array.isArray(result) ? result : [result];
      pending -= 1;
      if (pending === 0) {
        completed = true;
        var results = [];
        resultGroups.forEach(function (group) {
          Array.prototype.push.apply(results, group || []);
        });
        finishPanel(renderPanel(results, settings));
      }
    }, settings.requestTimeout);
  });
})();

function parseArgs(input) {
  var output = {};
  if (!input) return output;

  input.split("&").forEach(function (item) {
    if (!item) return;
    var separator = item.indexOf("=");
    var rawKey = separator >= 0 ? item.slice(0, separator) : item;
    var rawValue = separator >= 0 ? item.slice(separator + 1) : "";
    var key = safeDecode(rawKey.replace(/\+/g, " "));
    output[key] = safeDecode(rawValue.replace(/\+/g, " "));
  });

  return output;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function parseServers(args) {
  var keys = Object.keys(args).filter(function (key) {
    return /^(server|vps)\d+$/i.test(key);
  });

  keys.sort(function (a, b) {
    return numericSuffix(a) - numericSuffix(b);
  });

  var values = keys.map(function (key) { return args[key]; });
  if (args.servers) {
    values = values.concat(args.servers.split(";"));
  }

  var servers = values.map(parseServerValue).filter(Boolean);

  // 兼容原脚本：veid=...&apikey=...&title=BWG
  if (!servers.length && args.veid && (args.apikey || args.api_key)) {
    servers.push({
      name: args.title || "BWG",
      provider: "bwg",
      veid: args.veid,
      apiKey: args.apikey || args.api_key,
      expires: args.expires || args.expire || ""
    });
  }

  return servers;
}

function numericSuffix(value) {
  var match = String(value).match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function parseServerValue(value) {
  if (!value) return null;
  value = String(value).trim();
  if (!value) return null;

  if (value.charAt(0) === "{") {
    try {
      return normalizeServerConfig(JSON.parse(value));
    } catch (_) {
      return null;
    }
  }

  var parts = value.split("|");
  var provider = String(parts[1] || "bwg").toLowerCase();
  if (provider === "bwg" || provider === "bandwagon" || provider === "kiwivm") {
    return normalizeServerConfig({
      name: parts[0],
      provider: "bwg",
      veid: parts[2],
      apiKey: parts[3],
      expires: parts[4]
    });
  }

  if (provider === "json" || provider === "generic") {
    return normalizeServerConfig({
      name: parts[0],
      provider: "json",
      url: parts[2],
      token: parts[3],
      expires: parts[4]
    });
  }

  if (provider === "vps" || provider === "v.ps" || provider === "vpshosting") {
    return normalizeServerConfig({
      name: parts[0] || "V.PS",
      provider: "vps",
      username: parts[2],
      password: parts[3]
    });
  }

  return normalizeServerConfig({
    name: parts[0],
    provider: provider,
    error: "暂不支持服务商类型：" + provider
  });
}

function normalizeServerConfig(config) {
  if (!config || typeof config !== "object") return null;
  return {
    name: String(config.name || config.title || "VPS"),
    provider: String(config.provider || config.type || "bwg").toLowerCase(),
    veid: config.veid != null ? String(config.veid) : "",
    apiKey: String(config.apiKey || config.apikey || config.api_key || ""),
    url: String(config.url || config.endpoint || ""),
    token: String(config.token || ""),
    username: String(config.username || config.email || ""),
    password: String(config.password || ""),
    headers: config.headers && typeof config.headers === "object" ? config.headers : null,
    expires: config.expires || config.expires_at || config.expiration || "",
    error: config.error || ""
  };
}

function fetchServer(server, callback, timeout) {
  if (server.error) {
    callback(errorResult(server, server.error));
    return;
  }

  if (server.provider === "bwg") {
    fetchBwg(server, callback, timeout);
    return;
  }

  if (server.provider === "json" || server.provider === "generic") {
    fetchJson(server, callback, timeout);
    return;
  }


  if (server.provider === "vps" || server.provider === "v.ps" || server.provider === "vpshosting") {
    fetchVpsAccount(server, callback, timeout);
    return;
  }

  callback(errorResult(server, "暂不支持服务商类型：" + server.provider));
}

function fetchBwg(server, callback, timeout) {
  if (!server.veid || !server.apiKey) {
    callback(errorResult(server, "缺少 VEID 或 API Key"));
    return;
  }

  var url = "https://api.64clouds.com/v1/getLiveServiceInfo" +
    "?veid=" + encodeURIComponent(server.veid) +
    "&api_key=" + encodeURIComponent(server.apiKey);

  httpGet({ url: url, timeout: timeout }, function (error, data) {
    if (error) {
      callback(errorResult(server, error));
      return;
    }

    var json;
    try {
      json = JSON.parse(data);
    } catch (_) {
      callback(errorResult(server, "API 返回的不是有效 JSON"));
      return;
    }

    if (Number(json.error || 0) !== 0) {
      callback(errorResult(server, cleanMessage(json.message || "API 拒绝请求")));
      return;
    }

    var multiplier = positiveNumber(json.monthly_data_multiplier, 1);
    var trafficUsed = nullableNumber(json.data_counter);
    if (trafficUsed != null) trafficUsed *= multiplier;

    var memoryTotal = nullableNumber(json.plan_ram);
    var memoryAvailable = nullableNumber(json.mem_available_kb);
    var memoryUsed = memoryTotal != null && memoryAvailable != null
      ? Math.max(0, memoryTotal - memoryAvailable * 1024)
      : null;

    callback({
      ok: true,
      name: server.name,
      provider: "bwg",
      status: normalizeStatus(json.ve_status || json.status),
      traffic: {
        used: trafficUsed,
        total: nullableNumber(json.plan_monthly_data),
        reset: json.data_next_reset || ""
      },
      memory: {
        used: memoryUsed,
        total: memoryTotal
      },
      disk: {
        used: nullableNumber(json.ve_used_disk_space_b),
        total: nullableNumber(json.plan_disk)
      },
      expires: server.expires || json.plan_expiration || json.expires_at || ""
    });
  });
}

function fetchVpsAccount(server, callback, timeout) {
  if (!server.username || !server.password) {
    callback(errorResult(server, "缺少 V.PS 登录邮箱或密码"));
    return;
  }

  var headers = {
    Accept: "application/json",
    Authorization: "Basic " + base64EncodeUtf8(server.username + ":" + server.password)
  };

  getJson("https://vps.hosting/api/service", headers, timeout, function (error, json) {
    if (error) {
      callback(errorResult(server, error));
      return;
    }

    var services = json && Array.isArray(json.services) ? json.services : [];
    services = services.filter(function (service) {
      return service && !/cancelled|terminated|deleted/i.test(String(service.status || ""));
    });

    if (!services.length) {
      callback(errorResult(server, "V.PS 账户内没有可用服务"));
      return;
    }

    var pending = services.length * 2;
    var details = services.map(function (service) {
      return { service: service, resources: null, vms: null };
    });

    services.forEach(function (service, index) {
      var baseUrl = "https://vps.hosting/api/service/" + encodeURIComponent(service.id);

      getJson(baseUrl + "/resources", headers, timeout, function (resourceError, resourceJson) {
        details[index].resources = resourceError ? null : resourceJson;
        completeOne();
      });

      getJson(baseUrl + "/vms", headers, timeout, function (vmError, vmJson) {
        details[index].vms = vmError ? null : vmJson;
        completeOne();
      });
    });

    function completeOne() {
      pending -= 1;
      if (pending === 0) {
        callback(details.map(function (detail) {
          return normalizeVpsResult(server, detail.service, detail.resources, detail.vms);
        }));
      }
    }
  });
}

function normalizeVpsResult(server, service, resourceJson, vmJson) {
  var resources = resourceJson || {};
  var remaining = resources.limit || {};
  var totals = resources.total || {};
  var vmMap = vmJson && vmJson.vms && typeof vmJson.vms === "object" ? vmJson.vms : {};
  var vms = Object.keys(vmMap).map(function (key) { return vmMap[key]; }).filter(Boolean);

  var totalTrafficGb = nullableNumber(totals.data_combined);
  var remainingTrafficGb = nullableNumber(remaining.data_combined);
  var usedTrafficGb = totalTrafficGb != null && remainingTrafficGb != null
    ? Math.max(0, totalTrafficGb - remainingTrafficGb)
    : null;

  var memoryMb = nullableNumber(totals.mem);
  var diskGb = nullableNumber(totals.disk);
  if (memoryMb == null && vms.length) {
    memoryMb = sumNumbers(vms, "memory");
  }
  if (diskGb == null && vms.length) {
    diskGb = sumNumbers(vms, "disk");
  }

  var status = normalizeStatus(service.status);
  if (vms.length) {
    var running = vms.filter(function (vm) {
      return normalizeStatus(vm.status || (vm.power ? "running" : "stopped")) === "online";
    }).length;
    status = running === vms.length ? "online" : running === 0 ? "offline" : "unknown";
  }

  var location = service.category || service.name || service.domain || service.id;
  return {
    ok: true,
    name: server.name + (location ? " · " + location : ""),
    provider: "vps",
    status: status,
    resourceMode: "plan",
    traffic: {
      used: usedTrafficGb == null ? null : usedTrafficGb * Math.pow(1024, 3),
      total: totalTrafficGb == null ? null : totalTrafficGb * Math.pow(1024, 3),
      reset: ""
    },
    memory: {
      used: null,
      total: memoryMb == null ? null : memoryMb * Math.pow(1024, 2)
    },
    disk: {
      used: null,
      total: diskGb == null ? null : diskGb * Math.pow(1024, 3)
    },
    expires: service.next_due || "",
    billingCycle: service.billingcycle || ""
  };
}

function getJson(url, headers, timeout, callback) {
  httpGet({ url: url, headers: headers, timeout: timeout }, function (error, data) {
    if (error) {
      callback(error);
      return;
    }

    var json;
    try {
      json = JSON.parse(data);
    } catch (_) {
      callback("API 返回的不是有效 JSON");
      return;
    }

    var hasError = json && (Array.isArray(json.error) ? json.error.length > 0 : Boolean(json.error));
    if (hasError) {
      var message = Array.isArray(json.error) ? json.error.join("；") : json.error;
      callback(cleanMessage(message || json.message || "API 返回错误"));
      return;
    }

    callback(null, json);
  });
}

function fetchJson(server, callback, timeout) {
  if (!server.url || !/^https?:\/\//i.test(server.url)) {
    callback(errorResult(server, "缺少有效的 HTTP(S) JSON 接口"));
    return;
  }

  var headers = cloneObject(server.headers || {});
  if (server.token && server.token !== "-") {
    headers.Authorization = /^Bearer\s/i.test(server.token)
      ? server.token
      : "Bearer " + server.token;
  }

  httpGet({ url: server.url, headers: headers, timeout: timeout }, function (error, data) {
    if (error) {
      callback(errorResult(server, error));
      return;
    }

    var json;
    try {
      json = JSON.parse(data);
    } catch (_) {
      callback(errorResult(server, "接口返回的不是有效 JSON"));
      return;
    }

    if (json && Number(json.error || 0) !== 0) {
      callback(errorResult(server, cleanMessage(json.message || "接口返回错误")));
      return;
    }

    callback(normalizeJsonResult(server, json));
  });
}

function normalizeJsonResult(server, json) {
  var payload = json && json.data && typeof json.data === "object" ? json.data : (json || {});
  var traffic = payload.traffic || payload.bandwidth || payload.network || {};
  var memory = payload.memory || payload.mem || payload.ram || {};
  var disk = payload.disk || payload.storage || {};

  var memoryTotal = firstNumber(memory.total, payload.memory_total, payload.mem_total, payload.ram_total);
  var memoryUsed = firstNumber(memory.used, payload.memory_used, payload.mem_used, payload.ram_used);
  var memoryAvailable = firstNumber(memory.available, payload.memory_available, payload.mem_available);
  if (memoryUsed == null && memoryTotal != null && memoryAvailable != null) {
    memoryUsed = Math.max(0, memoryTotal - memoryAvailable);
  }

  return {
    ok: true,
    name: server.name || payload.name || "VPS",
    provider: "json",
    status: normalizeStatus(payload.status || payload.state),
    traffic: {
      used: firstNumber(traffic.used, payload.traffic_used, payload.bandwidth_used, payload.data_counter),
      total: firstNumber(traffic.total, payload.traffic_total, payload.bandwidth_total, payload.plan_monthly_data),
      reset: traffic.reset || traffic.reset_at || payload.traffic_reset || payload.data_next_reset || ""
    },
    memory: {
      used: memoryUsed,
      total: memoryTotal
    },
    disk: {
      used: firstNumber(disk.used, payload.disk_used, payload.storage_used),
      total: firstNumber(disk.total, payload.disk_total, payload.storage_total)
    },
    expires: server.expires || payload.expires_at || payload.expiration || payload.expired_at || payload.due_date || ""
  };
}

function httpGet(options, callback) {
  var settled = false;
  var timeoutSeconds = clampNumber(options && options.timeout, 2, 10, 6);
  var watchdog = setTimeout(function () {
    finish("请求超时");
  }, timeoutSeconds * 1000 + 300);

  function finish(error, data) {
    if (settled) return;
    settled = true;
    if (typeof clearTimeout === "function") clearTimeout(watchdog);
    callback(error, data);
  }

  try {
    $httpClient.get(options, function (error, response, data) {
      if (error) {
        finish(classifyNetworkError(error));
        return;
      }

      var status = response && Number(response.status || response.statusCode || 0);
      if (status >= 400) {
        finish("HTTP " + status);
        return;
      }

      finish(null, data == null ? "" : String(data));
    });
  } catch (error) {
    finish(classifyNetworkError(error));
  }
}

function classifyNetworkError(error) {
  var text = cleanMessage(error && (error.message || error.error) || error || "网络请求失败");
  if (/timed?\s*out|timeout|超时/i.test(text)) return "请求超时";
  if (/not connected|network|offline|internet|网络/i.test(text)) return "网络不可用";
  return text || "网络请求失败";
}

function errorResult(server, message) {
  return {
    ok: false,
    name: server.name || "VPS",
    provider: server.provider || "unknown",
    error: cleanMessage(message)
  };
}

function renderPanel(results, settings) {
  var successful = results.filter(function (item) { return item && item.ok; });
  var problems = results.length - successful.length;
  var severity = problems ? 2 : 0;
  var totalUsed = 0;
  var totalLimit = 0;
  var trafficCount = 0;

  successful.forEach(function (item) {
    var ratio = percentage(item.traffic && item.traffic.used, item.traffic && item.traffic.total);
    var expireDays = daysUntil(item.expires);
    if (ratio != null) {
      severity = Math.max(severity, ratio >= 95 ? 2 : ratio >= 85 ? 1 : 0);
    }
    if (expireDays != null) {
      severity = Math.max(severity, expireDays <= 3 ? 2 : expireDays <= 14 ? 1 : 0);
    }
    if (item.status === "offline") severity = Math.max(severity, 2);

    if (item.traffic && item.traffic.used != null && item.traffic.total != null) {
      totalUsed += item.traffic.used;
      totalLimit += item.traffic.total;
      trafficCount += 1;
    }
  });

  var lines = [];
  if (trafficCount > 1 && totalLimit > 0) {
    lines.push("总流量  " + formatUsage(totalUsed, totalLimit, false));
    lines.push("");
  }

  results.forEach(function (item, index) {
    if (!item || !item.ok) {
      lines.push("× " + ((item && item.name) || "VPS") + " · 获取失败");
      lines.push("  " + ((item && item.error) || "未知错误"));
    } else {
      Array.prototype.push.apply(lines, renderServer(item, settings));
    }
    if (index !== results.length - 1) lines.push("");
  });

  var colors = ["#30D158", "#FF9F0A", "#FF453A"];
  return {
    title: settings.title + " · " + successful.length + "/" + results.length,
    content: lines.join("\n"),
    icon: settings.icon,
    "icon-color": colors[severity]
  };
}

function renderServer(item, settings) {
  var lines = [];
  var status = statusDisplay(item.status);
  lines.push(status.symbol + " " + item.name + (status.label ? " · " + status.label : ""));

  if (hasUsage(item.traffic)) {
    var trafficRatio = percentage(item.traffic.used, item.traffic.total);
    var trafficLine = "流量  " + formatUsage(item.traffic.used, item.traffic.total, true);
    if (settings.showBar && trafficRatio != null) trafficLine += "  " + progressBar(trafficRatio, 8);
    lines.push(trafficLine);
  } else {
    lines.push("流量  暂无数据");
  }

  if (settings.showDetails) {
    var details = [];
    if (item.resourceMode === "plan") {
      if (item.memory && item.memory.total != null) details.push("内存 " + formatBytes(item.memory.total));
      if (item.disk && item.disk.total != null) details.push("磁盘 " + formatBytes(item.disk.total));
      if (details.length) details[0] = "配置 " + details[0];
    } else {
      if (hasUsage(item.memory)) details.push("内存 " + formatUsage(item.memory.used, item.memory.total, true));
      if (hasUsage(item.disk)) details.push("磁盘 " + formatUsage(item.disk.used, item.disk.total, true));
    }
    if (details.length) lines.push(details.join(" · "));
  }

  var dates = [];
  if (item.traffic && item.traffic.reset) {
    dates.push("重置 " + formatDateWithDays(item.traffic.reset));
  }
  if (item.expires) {
    dates.push("到期 " + formatDateWithDays(item.expires));
  }
  if (dates.length) lines.push(dates.join(" ｜ "));

  return lines;
}

function hasUsage(value) {
  return value && (value.used != null || value.total != null);
}

function formatUsage(used, total, compact) {
  var usedText = used == null ? "--" : formatBytes(used);
  var totalText = total == null ? "--" : formatBytes(total);
  var ratio = percentage(used, total);
  var output = usedText + " / " + totalText;
  if (ratio != null) output += compact ? " " + formatPercent(ratio) : " · " + formatPercent(ratio);
  return output;
}

function formatBytes(bytes) {
  var value = Number(bytes);
  if (!isFinite(value) || value < 0) return "--";
  if (value === 0) return "0 B";
  var units = ["B", "KB", "MB", "GB", "TB", "PB"];
  var index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  var converted = value / Math.pow(1024, index);
  var digits = converted >= 100 ? 0 : converted >= 10 ? 1 : 2;
  return converted.toFixed(digits) + " " + units[index];
}

function percentage(used, total) {
  used = nullableNumber(used);
  total = nullableNumber(total);
  if (used == null || total == null || total <= 0) return null;
  return used / total * 100;
}

function formatPercent(value) {
  return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + "%";
}

function progressBar(value, width) {
  var ratio = Math.max(0, Math.min(100, value));
  var filled = Math.round(ratio / 100 * width);
  return repeat("█", filled) + repeat("░", width - filled);
}

function repeat(character, count) {
  var output = "";
  while (count-- > 0) output += character;
  return output;
}

function normalizeStatus(value) {
  var status = String(value == null ? "" : value).toLowerCase();
  if (!status) return "unknown";
  if (/running|online|active|started|up|已运行|在线/.test(status)) return "online";
  if (/stopped|offline|suspended|disabled|down|关机|离线|暂停/.test(status)) return "offline";
  return "unknown";
}

function statusDisplay(status) {
  if (status === "online") return { symbol: "●", label: "在线" };
  if (status === "offline") return { symbol: "○", label: "离线" };
  return { symbol: "◆", label: "状态未知" };
}

function parseTimestamp(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();

  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value).trim())) {
    var number = Number(value);
    if (!isFinite(number)) return null;
    return number < 1000000000000 ? number * 1000 : number;
  }

  var text = String(value).trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) text += "T23:59:59";
  var timestamp = new Date(text).getTime();
  return isNaN(timestamp) ? null : timestamp;
}

function formatDateWithDays(value) {
  var timestamp = parseTimestamp(value);
  if (timestamp == null) return String(value);
  var date = new Date(timestamp);
  var label = date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  var days = daysUntil(timestamp);
  if (days == null) return label;
  if (days < 0) return label + " · 已过期 " + Math.abs(days) + " 天";
  if (days === 0) return label + " · 今天";
  return label + " · " + days + " 天";
}

function daysUntil(value) {
  var timestamp = typeof value === "number" ? value : parseTimestamp(value);
  if (timestamp == null) return null;
  return Math.ceil((timestamp - Date.now()) / 86400000);
}

function pad2(value) {
  return value < 10 ? "0" + value : String(value);
}

function firstNumber() {
  for (var i = 0; i < arguments.length; i += 1) {
    var number = nullableNumber(arguments[i]);
    if (number != null) return number;
  }
  return null;
}

function sumNumbers(items, key) {
  var total = 0;
  var found = false;
  (items || []).forEach(function (item) {
    var value = nullableNumber(item && item[key]);
    if (value != null) {
      total += value;
      found = true;
    }
  });
  return found ? total : null;
}

function base64EncodeUtf8(value) {
  var encoded = encodeURIComponent(String(value));
  var bytes = [];
  for (var i = 0; i < encoded.length; i += 1) {
    if (encoded.charAt(i) === "%") {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i));
    }
  }

  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var output = "";
  for (var offset = 0; offset < bytes.length; offset += 3) {
    var a = bytes[offset];
    var b = offset + 1 < bytes.length ? bytes[offset + 1] : 0;
    var c = offset + 2 < bytes.length ? bytes[offset + 2] : 0;
    var triple = (a << 16) | (b << 8) | c;
    output += alphabet.charAt((triple >> 18) & 63);
    output += alphabet.charAt((triple >> 12) & 63);
    output += offset + 1 < bytes.length ? alphabet.charAt((triple >> 6) & 63) : "=";
    output += offset + 2 < bytes.length ? alphabet.charAt(triple & 63) : "=";
  }
  return output;
}

function nullableNumber(value) {
  if (value == null || value === "") return null;
  var number = Number(value);
  return isFinite(number) ? number : null;
}

function positiveNumber(value, fallback) {
  var number = nullableNumber(value);
  return number != null && number > 0 ? number : fallback;
}

function clampNumber(value, min, max, fallback) {
  var number = nullableNumber(value);
  if (number == null) return fallback;
  return Math.max(min, Math.min(max, number));
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(value));
}

function cleanMessage(value) {
  return String(value == null ? "未知错误" : value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/https?:\/\/\S+/g, "接口地址")
    .slice(0, 100);
}

function cloneObject(source) {
  var output = {};
  Object.keys(source || {}).forEach(function (key) { output[key] = source[key]; });
  return output;
}

function finishPanel(result) {
  try {
    $done(result);
  } catch (error) {
    console.log("VPS Monitor: " + cleanMessage(error));
  }
}
