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
 *   server2=V.PS|vps|ACCESS_TOKEN|REFRESH_TOKEN|EMAIL|PASSWORD
 *   server3=V.PS|vps|||EMAIL|PASSWORD（全自动登录模式）
 *   server4=名称|json|URL|BEARER_TOKEN|YYYY-MM-DD
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
      token: parts[2],
      refreshToken: parts[3],
      username: parts[4],
      password: parts.slice(5).join("|")
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
    refreshToken: String(config.refreshToken || config.refresh || config.refresh_token || ""),
    username: String(config.username || config.email || ""),
    password: String(config.password || ""),
    headers: config.headers && typeof config.headers === "object" ? config.headers : null,
    expires: sanitizeExpiry(config.expires || config.expires_at || config.expiration || ""),
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
      expires: sanitizeExpiry(server.expires || json.plan_expiration || json.expires_at || "")
    });
  });
}

function fetchVpsAccount(server, callback, timeout) {
  if (!server.token && !server.refreshToken && !hasVpsLogin(server)) {
    callback(errorResult(server, "缺少 V.PS Token，或自动登录所需的邮箱和密码"));
    return;
  }

  resolveVpsAuth(server, timeout, function (authError, auth) {
    if (authError) {
      callback(errorResult(server, authError));
      return;
    }
    fetchVpsServices(server, auth, timeout, callback, false);
  });
}

function fetchVpsServices(server, auth, timeout, callback, retried) {
  var headers = vpsAuthHeaders(auth.token);

  getJson("https://vps.hosting/api/service", headers, timeout, function (error, json, status) {
    if (isVpsAuthError(error, status) && !retried && (auth.refresh || hasVpsLogin(server))) {
      renewVpsAuth(server, auth, timeout, function (renewError, renewedAuth) {
        if (renewError) {
          callback(errorResult(server, renewError));
          return;
        }
        fetchVpsServices(server, renewedAuth, timeout, callback, true);
      });
      return;
    }

    if (error) {
      var message = isVpsAuthError(error, status)
        ? "V.PS 自动认证失败，请检查账户凭据"
        : error;
      callback(errorResult(server, message));
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

function resolveVpsAuth(server, timeout, callback) {
  var auth = loadVpsAuth(server);
  if (!auth.token || jwtExpiresSoon(auth.token, 60)) {
    renewVpsAuth(server, auth, timeout, callback);
    return;
  }

  if (!auth.token) {
    callback("缺少可用的 V.PS Access Token");
    return;
  }

  callback(null, auth);
}

function renewVpsAuth(server, auth, timeout, callback) {
  if (auth && auth.refresh) {
    refreshVpsAuth(server, auth.refresh, timeout, function (refreshError, refreshedAuth) {
      if (!refreshError) {
        callback(null, refreshedAuth);
        return;
      }

      if (hasVpsLogin(server)) {
        loginVpsAuth(server, timeout, callback);
        return;
      }

      callback(refreshError);
    });
    return;
  }

  if (hasVpsLogin(server)) {
    loginVpsAuth(server, timeout, callback);
    return;
  }

  callback("缺少可用的 V.PS Access Token 或自动登录凭据");
}

function loginVpsAuth(server, timeout, callback) {
  postJson(
    "https://vps.hosting/api/login",
    { username: server.username, password: server.password },
    timeout,
    function (error, json, status) {
      if (error) {
        var message = status === 401 || status === 403 || /login|credential|password/i.test(String(error))
          ? "V.PS 自动登录失败：邮箱或密码错误"
          : "V.PS 自动登录失败：" + error;
        callback(message);
        return;
      }

      var payload = json && json.data && typeof json.data === "object" ? json.data : (json || {});
      var auth = {
        token: stripBearer(payload.token || payload.access_token || ""),
        refresh: stripBearer(payload.refresh || payload.refresh_token || "")
      };
      if (!auth.token) {
        callback("V.PS 自动登录失败：接口未返回 Access Token");
        return;
      }

      saveVpsAuth(server, auth);
      callback(null, auth);
    }
  );
}

function hasVpsLogin(server) {
  return Boolean(server && server.username && server.password);
}

function isVpsAuthError(error, status) {
  if (status === 401 || status === 403) return true;
  return /unauthori[sz]ed|token[^\n]*(invalid|expired)|refresh_token_invalid/i.test(String(error || ""));
}

function refreshVpsAuth(server, refreshToken, timeout, callback) {
  postJson(
    "https://vps.hosting/api/token",
    { refresh_token: stripBearer(refreshToken) },
    timeout,
    function (error, json, status) {
      if (error) {
        var message = status === 401 || status === 403
          ? "V.PS Refresh Token 已失效，请重新生成 Token"
          : "V.PS Token 刷新失败：" + error;
        callback(message);
        return;
      }

      var payload = json && json.data && typeof json.data === "object" ? json.data : (json || {});
      var token = stripBearer(payload.token || payload.access_token || "");
      var refresh = stripBearer(payload.refresh || payload.refresh_token || refreshToken || "");
      if (!token) {
        callback("V.PS Token 刷新失败：接口未返回 Access Token");
        return;
      }

      var auth = { token: token, refresh: refresh };
      saveVpsAuth(server, auth);
      callback(null, auth);
    }
  );
}

function loadVpsAuth(server) {
  var configured = {
    token: stripBearer(server.token),
    refresh: stripBearer(server.refreshToken)
  };

  if (typeof $persistentStore === "undefined" || !$persistentStore ||
      typeof $persistentStore.read !== "function") {
    return configured;
  }

  try {
    var saved = JSON.parse($persistentStore.read(vpsAuthStoreKey(server)) || "null");
    if (!saved || typeof saved !== "object") return configured;
    return {
      token: stripBearer(saved.token || configured.token),
      refresh: stripBearer(saved.refresh || configured.refresh)
    };
  } catch (_) {
    return configured;
  }
}

function saveVpsAuth(server, auth) {
  if (typeof $persistentStore === "undefined" || !$persistentStore ||
      typeof $persistentStore.write !== "function") return;

  try {
    $persistentStore.write(JSON.stringify({
      token: stripBearer(auth.token),
      refresh: stripBearer(auth.refresh)
    }), vpsAuthStoreKey(server));
  } catch (_) {
    // 持久化失败不影响本次请求；下次运行仍可用配置里的 Token。
  }
}

function vpsAuthStoreKey(server) {
  var seed = [server.name, server.token, server.refreshToken, server.username].join("|");
  var hash = 2166136261;
  for (var index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return "vps-monitor.vps-auth." + (hash >>> 0).toString(16);
}

function vpsAuthHeaders(token) {
  return {
    Accept: "application/json",
    Authorization: "Bearer " + stripBearer(token)
  };
}

function stripBearer(token) {
  return String(token || "").replace(/^Bearer\s+/i, "").trim();
}

function sanitizeExpiry(value) {
  var text = String(value || "").trim();
  if (!text || /^(YOUR_|YOUR\s|YYYY|请填|填写|你的)/i.test(text)) return "";
  return text;
}

function jwtExpiresSoon(token, skewSeconds) {
  var parts = stripBearer(token).split(".");
  if (parts.length !== 3) return false;

  try {
    var payload = JSON.parse(decodeBase64Url(parts[1]));
    var expires = Number(payload.exp);
    if (!isFinite(expires) || expires <= 0) return false;
    return expires <= Math.floor(Date.now() / 1000) + Number(skewSeconds || 0);
  } catch (_) {
    return false;
  }
}

function decodeBase64Url(input) {
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var value = String(input || "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/g, "");
  var output = "";
  var buffer = 0;
  var bits = 0;

  for (var index = 0; index < value.length; index += 1) {
    var digit = alphabet.indexOf(value.charAt(index));
    if (digit < 0) throw new Error("无效的 Base64URL");
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 255);
    }
  }
  return output;
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
      reset: nextMonthlyTrafficReset()
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
  requestJson("get", { url: url, headers: headers, timeout: timeout }, callback);
}

function postJson(url, body, timeout, callback) {
  requestJson("post", {
    url: url,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    timeout: timeout
  }, callback);
}

function requestJson(method, options, callback) {
  httpRequest(method, options, function (error, data, status) {
    if (error) {
      callback(error, null, status);
      return;
    }

    var json;
    try {
      json = JSON.parse(data);
    } catch (_) {
      callback("API 返回的不是有效 JSON", null, status);
      return;
    }

    var hasError = json && (Array.isArray(json.error) ? json.error.length > 0 : Boolean(json.error));
    if (hasError) {
      var message = Array.isArray(json.error) ? json.error.join("；") : json.error;
      callback(cleanMessage(message || json.message || "API 返回错误"), null, status);
      return;
    }

    callback(null, json, status);
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
  httpRequest("get", options, callback);
}

function httpRequest(method, options, callback) {
  var settled = false;
  var timeoutSeconds = clampNumber(options && options.timeout, 2, 10, 6);
  var watchdog = setTimeout(function () {
    finish("请求超时", null, 0);
  }, timeoutSeconds * 1000 + 300);

  function finish(error, data, status) {
    if (settled) return;
    settled = true;
    if (typeof clearTimeout === "function") clearTimeout(watchdog);
    callback(error, data, status || 0);
  }

  try {
    var requester = $httpClient && $httpClient[method];
    if (typeof requester !== "function") {
      finish("当前 Surge 环境不支持 HTTP " + String(method).toUpperCase(), null, 0);
      return;
    }

    requester.call($httpClient, options, function (error, response, data) {
      if (error) {
        finish(classifyNetworkError(error), null, 0);
        return;
      }

      var status = response && Number(response.status || response.statusCode || 0);
      if (status >= 400) {
        finish("HTTP " + status, null, status);
        return;
      }

      finish(null, data == null ? "" : String(data), status);
    });
  } catch (error) {
    finish(classifyNetworkError(error), null, 0);
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

function nextMonthlyTrafficReset() {
  var now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
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
