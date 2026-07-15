<?php
error_reporting(E_ALL);
ini_set('display_errors', 0); // No mostrar errores en producción

// Con cookies de sesión hace falta reflejar el Origin y permitir credenciales
// (Allow-Origin: * es incompatible con credenciales). En prod el SPA es same-origin,
// así que esto solo importa para dev cross-origin (localhost:3000 → :4000) y curl.
$__origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($__origin !== '') {
    header('Access-Control-Allow-Origin: ' . $__origin);
    header('Access-Control-Allow-Credentials: true');
} else {
    header('Access-Control-Allow-Origin: *');
}
header('Access-Control-Allow-Methods: GET, POST, OPTIONS, PUT, DELETE');
header('Access-Control-Allow-Headers: Content-Type, X-Requested-With');
header('Access-Control-Max-Age: 86400');

// Responder a preflight requests
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// Headers anti-cache para config
if (strpos($_SERVER['REQUEST_URI'], '/config') !== false || strpos($_SERVER['REQUEST_URI'], '/reset-config') !== false) {
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
}

// URI normalizada (sin barra final, sin query string)
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$uri = rtrim($uri, '/');
if ($uri === '') $uri = '/';

$PRINTBOX_BASE = 'http://gestion.printboxweb.com'; // ¡HTTP!
$cookiePath = __DIR__ . '/pba_cookies.txt'; // Guardar en la misma carpeta

// ── Diagnóstico ──
if ($uri === '/proxy.php') {
    header('Content-Type: application/json');
    echo json_encode([
        'status'       => 'ok',
        'php_version'  => PHP_VERSION,
        'curl'         => function_exists('curl_init'),
        'uri'          => $uri,
        'tmp_writable' => is_writable(__DIR__),
        'cookie_path'  => $cookiePath,
    ]);
    exit();
}

if (!function_exists('curl_init')) {
    header('Content-Type: application/json');
    http_response_code(500);
    echo json_encode(['error' => 'cURL no disponible']);
    exit();
}

// ── Funciones helper ──

function getConfigDir() {
    $scriptConfig = __DIR__ . '/config';
    if (is_dir($scriptConfig) && is_writable($scriptConfig)) {
        return $scriptConfig;
    }

    // En Windows local: usar LOCALAPPDATA si el directorio existe o si se puede crear
    $localAppData = getenv('LOCALAPPDATA');
    if ($localAppData) {
        $dir = $localAppData . '/PrintboxAdventures/config';
        if (is_dir($dir) || is_writable(dirname($dir))) {
            return $dir;
        }
    }

    // En servidor web (IONOS): usar directorio del script como fallback
    return $scriptConfig;
}

// ── Sesión de hotel (cookie firmada HMAC, sin BD) ──
// Misma lógica que backend/lib/session.js (dev). El token solo lo valida el mismo
// backend que lo emitió, así que el secreto es local a cada despliegue.
define('PBH_COOKIE', 'pbh_session');
define('PBH_TTL', 43200); // 12 h en segundos

function pbhSanitizeHotelId($id) {
    return preg_replace('/[^a-z0-9_-]/', '', strtolower(trim((string)$id)));
}

function getSessionSecret($base) {
    $f = $base . '/session_secret.txt';
    if (is_file($f)) { $s = trim(@file_get_contents($f)); if ($s !== '') return $s; }
    $secret = bin2hex(random_bytes(32));
    if (!is_dir($base)) @mkdir($base, 0755, true);
    @file_put_contents($f, $secret);
    return $secret;
}

function pbhMakeToken($hotelId, $base) {
    $expiry = time() + PBH_TTL;
    $mac = hash_hmac('sha256', $hotelId . '|' . $expiry, getSessionSecret($base));
    return $hotelId . '|' . $expiry . '|' . $mac;
}

function pbhVerifyToken($token, $base) {
    if (!is_string($token) || $token === '') return null;
    $parts = explode('|', $token);
    if (count($parts) !== 3) return null;
    list($hotelId, $expiryStr, $mac) = $parts;
    $expiry = (int)$expiryStr;
    if ($hotelId === '' || $expiry <= 0 || time() > $expiry) return null;
    $expected = hash_hmac('sha256', $hotelId . '|' . $expiry, getSessionSecret($base));
    if (!hash_equals($expected, $mac)) return null;
    return $hotelId;
}

function getSessionHotelId($base) {
    return pbhVerifyToken($_COOKIE[PBH_COOKIE] ?? '', $base);
}

function readHotelsAccounts($base) {
    $f = $base . '/hotels.json';
    if (!is_file($f)) return [];
    $parsed = json_decode(@file_get_contents($f), true);
    return is_array($parsed) ? $parsed : [];
}

// Carpeta de config del hotel. hotelId válido → config/hotels/<id>; sin id → global
// (compat con el modelo antiguo de un solo hotel / QRs viejos sin ?hotel=).
function resolveHotelDir($base, $hotelId, $create = false) {
    $id = pbhSanitizeHotelId($hotelId);
    if ($id === '') return $base;
    $dir = $base . '/hotels/' . $id;
    if ($create && !is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}

// Carpeta de config para LECTURA: sesión (panel) o ?hotel= (móvil); si no, global.
function getReadConfigDir() {
    $base = getConfigDir();
    $hotelId = getSessionHotelId($base);
    if (!$hotelId) $hotelId = $_GET['hotel'] ?? '';
    return resolveHotelDir($base, $hotelId);
}

function pbhSetSessionCookie($token, $ttl) {
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    setcookie(PBH_COOKIE, $token, [
        'expires'  => $ttl > 0 ? time() + $ttl : time() - 3600,
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure'   => $secure,
    ]);
}

// Lee email_recepcion del textos.txt del hotel: precios/textos/email son por-hotel,
// no por habitación, así que un único email de recepción vale para todas sus habitaciones.
function getHotelReceptionEmail($configDir) {
    $textosFile = $configDir . '/textos.txt';
    // Limpiar caché de stat: sin esto, un textos.txt recién escrito por /config
    // (p. ej. segundos antes desde el panel Admin) puede parecer inexistente.
    clearstatcache(true, $textosFile);
    if (!file_exists($textosFile)) return '';
    $lines = file($textosFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        if (strpos(trim($line), 'email_recepcion:') === 0) {
            return trim(substr(trim($line), strlen('email_recepcion:')));
        }
    }
    return '';
}

// Habitaciones registradas del hotel: [{ nombre, codigo }] en config/habitaciones.json.
// codigo se guarda normalizado (sin prefijo ev-).
function readHabitaciones($configDir) {
    $file = $configDir . '/habitaciones.json';
    clearstatcache(true, $file);
    if (!file_exists($file)) return [];
    $parsed = json_decode(file_get_contents($file), true);
    return is_array($parsed) ? $parsed : [];
}

function sanitizeHabitaciones($input) {
    if (!is_array($input)) return [];
    $result = [];
    foreach ($input as $h) {
        if (!is_array($h)) continue;
        $nombre = mb_substr(trim(preg_replace('/[\r\n\t]/', ' ', (string)($h['nombre'] ?? ''))), 0, 40);
        $codigo = preg_replace('/[^0-9a-zA-Z_-]/', '', preg_replace('/^ev[-_]?/i', '', trim((string)($h['codigo'] ?? ''))));
        if ($codigo === '') continue;
        $result[] = ['nombre' => $nombre, 'codigo' => $codigo];
        if (count($result) >= 500) break;
    }
    return $result;
}

function encodeMimeSubject($text) {
    return '=?UTF-8?B?' . base64_encode($text) . '?=';
}

// Construye y envía (mail() nativo de IONOS, sin librerías) el aviso de pedido a recepción,
// con las miniaturas embebidas inline vía Content-ID — sin necesidad de SMTP/PHPMailer.
function sendRoomOrderEmail($to, $room, $items, $total, $paymentMethod) {
    $to = filter_var(trim($to), FILTER_VALIDATE_EMAIL);
    if (!$to) return false;

    $boundary = 'pb_' . md5(uniqid('', true));
    $roomEsc = htmlspecialchars($room, ENT_QUOTES, 'UTF-8');
    $totalEsc = htmlspecialchars($total, ENT_QUOTES, 'UTF-8');
    $paymentEsc = htmlspecialchars($paymentMethod, ENT_QUOTES, 'UTF-8');

    $rowsHtml = '';
    $imageParts = '';
    $i = 0;
    foreach ((array)$items as $item) {
        $i++;
        $copies = isset($item['copies']) ? (int) $item['copies'] : 1;
        $dataUrl = $item['thumbnail'] ?? '';
        if (!preg_match('#^data:image/(\w+);base64,(.+)$#', $dataUrl, $m)) continue;
        $ext = strtolower($m[1]);
        $imgData = base64_decode($m[2]);
        if ($imgData === false) continue;
        $cid = "pbphoto{$i}";
        $rowsHtml .= "<tr><td style=\"padding:8px;border-bottom:1px solid #eee;\"><img src=\"cid:{$cid}\" width=\"110\" style=\"border-radius:6px;display:block;\" alt=\"Foto {$i}\"></td>"
            . "<td style=\"padding:8px;border-bottom:1px solid #eee;text-align:center;font-family:Arial,sans-serif;font-size:15px;\">{$copies}</td></tr>";
        $imageParts .= "--{$boundary}\r\n"
            . "Content-Type: image/{$ext}; name=\"foto{$i}.{$ext}\"\r\n"
            . "Content-Transfer-Encoding: base64\r\n"
            . "Content-ID: <{$cid}>\r\n"
            . "Content-Disposition: inline; filename=\"foto{$i}.{$ext}\"\r\n\r\n"
            . chunk_split(base64_encode($imgData))
            . "\r\n";
    }

    if ($rowsHtml === '') return false; // nada que mostrar, no molestar a recepción con un email vacío

    $htmlBody = <<<HTML
<html><body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:24px;margin:0;">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #eee;">
  <div style="background:#14110d;color:#c9a24b;padding:18px 22px;font-size:18px;font-weight:bold;">Printbox Hotels</div>
  <div style="padding:22px;">
    <p style="margin:0 0 16px;font-size:16px;color:#222;">Nuevo pedido &mdash; <strong>Habitaci&oacute;n {$roomEsc}</strong></p>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="text-align:left;padding:8px;border-bottom:2px solid #eee;font-family:Arial,sans-serif;font-size:12px;color:#888;text-transform:uppercase;">Foto</th>
        <th style="padding:8px;border-bottom:2px solid #eee;font-family:Arial,sans-serif;font-size:12px;color:#888;text-transform:uppercase;">Copias</th>
      </tr></thead>
      <tbody>{$rowsHtml}</tbody>
    </table>
    <p style="margin-top:18px;font-size:15px;color:#222;">Total pagado: <strong>{$totalEsc}&euro;</strong> &middot; {$paymentEsc}</p>
  </div>
</div>
</body></html>
HTML;

    $subject = encodeMimeSubject("Printbox Hotels · Habitación {$room} · nuevas fotos");
    $host = preg_replace('/[^a-zA-Z0-9.\-]/', '', $_SERVER['HTTP_HOST'] ?? '') ?: 'localhost';

    $headers = "MIME-Version: 1.0\r\n"
        . "From: Printbox Hotels <no-reply@{$host}>\r\n"
        . "Content-Type: multipart/related; boundary=\"{$boundary}\"\r\n";

    $body = "--{$boundary}\r\n"
        . "Content-Type: text/html; charset=UTF-8\r\n"
        . "Content-Transfer-Encoding: 8bit\r\n\r\n"
        . $htmlBody . "\r\n\r\n"
        . $imageParts
        . "--{$boundary}--";

    return mail($to, $subject, $body, $headers);
}

function getPaypalConfigFile($configDir) {
    $result = [];

    $jsonPath = $configDir . '/paypal.json';
    if (file_exists($jsonPath)) {
        $content = file_get_contents($jsonPath);
        $parsed = json_decode($content, true);
        if (json_last_error() === JSON_ERROR_NONE && is_array($parsed)) {
            $result = array_merge($result, $parsed);
        }
    }

    $txtPath = $configDir . '/paypal.txt';
    if (file_exists($txtPath)) {
        $lines = file($txtPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        foreach ($lines as $line) {
            if (strpos(trim($line), '#') === 0) {
                continue;
            }
            $parts = explode('=', $line, 2);
            if (count($parts) === 2) {
                $key = trim($parts[0]);
                $value = trim($parts[1]);
                if ($key !== '') {
                    $result[$key] = $value;
                }
            }
        }
    }

    return $result;
}

function getPaypalCredentials($configDir) {
    $credentials = [
        'clientId' => getenv('PAYPAL_CLIENT_ID') ?: '',
        'clientSecret' => getenv('PAYPAL_CLIENT_SECRET') ?: '',
        'env' => getenv('PAYPAL_ENV') ?: '',
    ];

    if (!$credentials['clientId'] || !$credentials['clientSecret'] || !$credentials['env']) {
        $fileConfig = getPaypalConfigFile($configDir);
        if (!$credentials['clientId'] && !empty($fileConfig['clientId'])) {
            $credentials['clientId'] = $fileConfig['clientId'];
        }
        if (!$credentials['clientSecret'] && !empty($fileConfig['clientSecret'])) {
            $credentials['clientSecret'] = $fileConfig['clientSecret'];
        }
        if (!$credentials['env'] && !empty($fileConfig['env'])) {
            $credentials['env'] = $fileConfig['env'];
        }
    }

    if (!$credentials['env']) {
        $credentials['env'] = 'sandbox';
    }

    return $credentials;
}

// Credenciales de Square: variables de entorno si existen, si no config/square.json
// (fuera de git, protegido por config/.htaccess). Nunca hardcodeadas en el código.
function getSquareCredentials($configDir) {
    $accessToken = getenv('SQUARE_ACCESS_TOKEN') ?: '';
    $locationId  = getenv('SQUARE_LOCATION_ID') ?: '';
    if (!$accessToken || !$locationId) {
        $file = $configDir . '/square.json';
        if (file_exists($file)) {
            $parsed = json_decode(file_get_contents($file), true);
            if (is_array($parsed)) {
                if (!$accessToken) $accessToken = $parsed['accessToken'] ?? '';
                if (!$locationId)  $locationId  = $parsed['locationId'] ?? '';
            }
        }
    }
    return ['accessToken' => $accessToken, 'locationId' => $locationId];
}

function getCsrfToken() {
    global $PRINTBOX_BASE, $cookiePath;
    $ch = curl_init($PRINTBOX_BASE . '/sanctum/csrf-cookie');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_COOKIEJAR      => $cookiePath,
        CURLOPT_COOKIEFILE     => $cookiePath,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_USERAGENT      => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    ]);
    curl_exec($ch);
    curl_close($ch);

    if (file_exists($cookiePath)) {
        $cookies = file_get_contents($cookiePath);
        if (preg_match('/XSRF-TOKEN\s+([^\s\r\n]+)/', $cookies, $m)) {
            return urldecode($m[1]);
        }
    }
    return null;
}

function proxyPost($url, $data, $extraHeaders = []) {
    global $cookiePath;
    $json = json_encode($data);
    $headers = array_merge([
        'Content-Type: application/json',
        'Accept: application/json',
        'Content-Length: ' . strlen($json),
    ], $extraHeaders);

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $json,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_COOKIEJAR      => $cookiePath,
        CURLOPT_COOKIEFILE     => $cookiePath,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_USERAGENT      => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    ]);

    $response = curl_exec($ch);
    $code     = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error    = curl_error($ch);
    curl_close($ch);

    return ['code' => $code, 'body' => $response, 'error' => $error];
}

$body = file_get_contents('php://input');
$data = json_decode($body, true) ?? [];

// Log TODOS los requests para debuggear — el body de /auth/* nunca se loguea
// (llevaría la contraseña en texto plano).
$__logBody = (strpos($uri, '/auth/') === 0) ? '[redacted]' : substr($body, 0, 200);
@file_put_contents(__DIR__ . '/pba_requests.log',
    date('Y-m-d H:i:s') . " {$_SERVER['REQUEST_METHOD']} {$_SERVER['REQUEST_URI']} " .
    "Content-Length:" . ($_SERVER['CONTENT_LENGTH'] ?? '0') . " Body:" . $__logBody . "\n",
    FILE_APPEND);

header('Content-Type: application/json');

// ── /health ──
if ($uri === '/health') {
    echo json_encode(['ok' => true]);
    exit();
}

// ── /auth/* (login por hotel; cuentas en config/hotels.json creadas por Printbox) ──
if ($uri === '/auth/login' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $base = getConfigDir();
    $user = trim((string)($data['user'] ?? ''));
    $password = (string)($data['password'] ?? '');
    if ($user === '' || $password === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Usuario y contraseña requeridos']);
        exit();
    }
    $hotels = readHotelsAccounts($base);
    $foundId = null; $foundNombre = '';
    foreach ($hotels as $hid => $h) {
        if (($h['user'] ?? '') === $user && !empty($h['passHash']) && password_verify($password, $h['passHash'])) {
            $foundId = $hid; $foundNombre = $h['nombre'] ?? ''; break;
        }
    }
    if (!$foundId) {
        http_response_code(401);
        echo json_encode(['error' => 'Usuario o contraseña incorrectos']);
        exit();
    }
    pbhSetSessionCookie(pbhMakeToken($foundId, $base), PBH_TTL);
    echo json_encode(['ok' => true, 'hotelId' => $foundId, 'nombre' => $foundNombre]);
    exit();
}

if ($uri === '/auth/me' && $_SERVER['REQUEST_METHOD'] === 'GET') {
    $base = getConfigDir();
    $hotelId = getSessionHotelId($base);
    if (!$hotelId) {
        http_response_code(401);
        echo json_encode(['error' => 'No autenticado']);
        exit();
    }
    $hotels = readHotelsAccounts($base);
    echo json_encode(['hotelId' => $hotelId, 'nombre' => $hotels[$hotelId]['nombre'] ?? '']);
    exit();
}

if ($uri === '/auth/logout' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    pbhSetSessionCookie('', 0);
    echo json_encode(['ok' => true]);
    exit();
}

// ── /hotel-logo (por hotel) ──
// GET: sirve config/hotels/<id>/hotel-logo.png (hotel de la sesión o de ?hotel=), con
//   fallback al placeholder de assets/. POST: guarda el logo en la carpeta del hotel de
//   la SESIÓN — exige estar autenticado. Vive en config/ para sobrevivir a redespliegues.
if ($uri === '/hotel-logo') {
    $base = getConfigDir();

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $hotelId = getSessionHotelId($base);
        if (!$hotelId) {
            http_response_code(401);
            echo json_encode(['error' => 'No autenticado']);
            exit();
        }
        $image = (string)($data['image'] ?? '');
        if (!preg_match('#^data:image/(png|jpeg);base64,(.+)$#', $image, $m)) {
            http_response_code(400);
            echo json_encode(['error' => 'Formato inválido: se espera data URL PNG/JPEG']);
            exit();
        }
        $bytes = base64_decode($m[2], true);
        if ($bytes === false || strlen($bytes) === 0 || strlen($bytes) > 3 * 1024 * 1024) {
            http_response_code(400);
            echo json_encode(['error' => 'Imagen vacía, corrupta o mayor de 3MB']);
            exit();
        }
        $dir = resolveHotelDir($base, $hotelId, true);
        if (file_put_contents($dir . '/hotel-logo.png', $bytes) === false) {
            http_response_code(500);
            echo json_encode(['error' => 'No se pudo guardar el logo (permisos de config/)']);
            exit();
        }
        echo json_encode(['ok' => true]);
        exit();
    }

    // GET
    $customLogo = getReadConfigDir() . '/hotel-logo.png';
    clearstatcache(true, $customLogo);
    $file = file_exists($customLogo) ? $customLogo : __DIR__ . '/assets/hotel-logo.png';
    if (!file_exists($file)) {
        http_response_code(404);
        echo json_encode(['error' => 'Logo no encontrado']);
        exit();
    }
    header('Content-Type: image/png');
    header('Cache-Control: no-cache');
    header('Content-Length: ' . filesize($file));
    readfile($file);
    exit();
}

// ── /config GET ──
if ($uri === '/config' && $_SERVER['REQUEST_METHOD'] === 'GET') {
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
    
    // Limpiar caché para asegurar lectura fresca del disco
    clearstatcache(true);

    // Carpeta del hotel: sesión (panel) o ?hotel= (móvil); si no, global (compat).
    $configDir = getReadConfigDir();

    $config = [
        'servidor'  => 'http://gestion.printboxweb.com',
        'evento'    => '', 'timer' => 5, 'impresora' => '', 'delay' => 5,
        'servicio_disponible' => true,
    ];
    $textos = [
        'text_es' => '', 'text_en' => '', 'text_fr' => '', 'text_de' => '',
        'precio1' => '', 'precio2' => '', 'precio3' => '', 'empresa' => '', 'email_recepcion' => '',
    ];

    $apiFile = $configDir . '/servidor_api.txt';
    if (file_exists($apiFile)) {
        $lines = file($apiFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        $keys  = ['servidor', 'evento', 'evento_printer', 'timer', 'impresora', 'delay', 'servicio_disponible'];
        foreach ($lines as $i => $line) {
            $val = trim(strpos($line, ';') !== false ? explode(';', $line, 2)[1] : $line);
            if (isset($keys[$i])) {
                if ($keys[$i] === 'servicio_disponible') {
                    $config[$keys[$i]] = ($val !== '0');
                } else {
                    $config[$keys[$i]] = in_array($keys[$i], ['timer','delay']) ? ((int)$val ?: 5) : $val;
                }
            }
        }
    }

    // textos.txt del hotel (precios/textos/empresa/email son por-hotel)
    $textosFile = $configDir . '/textos.txt';
    if (file_exists($textosFile)) {
        $lines = file($textosFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        
        // Mapear claves cortas del archivo a claves largas esperadas por la app
        $keyMap = ['es' => 'text_es', 'en' => 'text_en', 'fr' => 'text_fr', 'de' => 'text_de'];
        
        foreach ($lines as $line) {
            $line = trim($line);
            if (strpos($line, ':') !== false) {
                $parts = explode(':', $line, 2);
                $shortKey = trim($parts[0]);
                $val = trim($parts[1] ?? '');
                
                // Convertir clave corta a larga si aplica
                $key = isset($keyMap[$shortKey]) ? $keyMap[$shortKey] : $shortKey;
                
                // Guardar si es una clave válida
                $validKeys = ['text_es','text_en','text_fr','text_de','precio1','precio2','precio3','empresa','email_recepcion'];
                if (in_array($key, $validKeys)) {
                    $textos[$key] = $val;
                }
            }
        }
    }

    echo json_encode(['config' => $config, 'textos' => $textos, 'habitaciones' => readHabitaciones($configDir)]);
    exit();
}

// ── /config POST ──
if ($uri === '/config' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    // Headers anti-cache
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
    
    // Escribir config exige sesión; se guarda SIEMPRE en la carpeta del hotel de la sesión.
    $base = getConfigDir();
    $sessionHotelId = getSessionHotelId($base);
    if (!$sessionHotelId) {
        http_response_code(401);
        echo json_encode(['error' => 'No autenticado']);
        exit();
    }
    $configDir = resolveHotelDir($base, $sessionHotelId, true);
    if (!is_dir($configDir)) {
        http_response_code(500);
        echo json_encode(['error' => 'No se pudo crear directorio del hotel']);
        exit();
    }

    $writeErrors = [];

    if (isset($data['habitaciones'])) {
        $ok = file_put_contents(
            $configDir . '/habitaciones.json',
            json_encode(sanitizeHabitaciones($data['habitaciones']), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)
        );
        if ($ok === false) $writeErrors[] = 'No se pudo escribir habitaciones.json';
    }

    if (isset($data['config'])) {
        $c = $data['config'];
        $success = file_put_contents($configDir . '/servidor_api.txt', implode("\n", [
            'servidor;' . ($c['servidor'] ?? 'http://gestion.printboxweb.com'),
            'evento;'   . ($c['evento']    ?? ''),
            'evento_printer;'   . ($c['evento_printer']    ?? ''),
            'timer;'    . ($c['timer']     ?? 5),
            'impresora;'. ($c['impresora'] ?? ''),
            'delay;'    . ($c['delay']     ?? 5),
            'servicio_disponible;' . ((($c['servicio_disponible'] ?? true) === false) ? '0' : '1'),
        ]));
        if ($success === false) $writeErrors[] = 'No se pudo escribir servidor_api.txt';
    }
    if (isset($data['textos'])) {
        $t = $data['textos'];
        
        $finalTextos = [
            'text_es' => $t['text_es'] ?? '¡Consigue tu foto de la habitación!',
            'text_en' => $t['text_en'] ?? 'Get your room photo!',
            'text_fr' => $t['text_fr'] ?? 'Obtenez votre photo!',
            'text_de' => $t['text_de'] ?? 'Hol dir dein Foto!',
            'precio1' => $t['precio1'] ?? '5',
            'precio2' => $t['precio2'] ?? '9',
            'precio3' => $t['precio3'] ?? '12',
            'empresa' => $t['empresa'] ?? 'Printbox Hotels',
            'email_recepcion' => $t['email_recepcion'] ?? '',
        ];

        $content = implode("\n", [
            'es:' . $finalTextos['text_es'],
            'en:' . $finalTextos['text_en'],
            'fr:' . $finalTextos['text_fr'],
            'de:' . $finalTextos['text_de'],
            'precio1:' . $finalTextos['precio1'],
            'precio2:' . $finalTextos['precio2'],
            'precio3:' . $finalTextos['precio3'],
            'empresa:' . $finalTextos['empresa'],
            'email_recepcion:' . $finalTextos['email_recepcion'],
        ]);
        
        // textos.txt del hotel (precios/textos/empresa/email son por-hotel)
        $success = file_put_contents($configDir . '/textos.txt', $content, LOCK_EX);
        if ($success === false) $writeErrors[] = 'No se pudo escribir textos.txt';
    }

    if (count($writeErrors) > 0) {
        http_response_code(500);
        echo json_encode(['ok' => false, 'errors' => $writeErrors]);
        exit();
    }

    // Limpiar caché de PHP antes de releer
    $textosFile = $configDir . '/textos.txt';
    clearstatcache(true, $configDir . '/servidor_api.txt');
    clearstatcache(true, $textosFile);

    // Leer y devolver los valores actualizados inmediatamente
    $config = ['servidor' => 'http://gestion.printboxweb.com', 'evento' => '', 'evento_printer' => '', 'timer' => 5, 'impresora' => '', 'delay' => 5, 'servicio_disponible' => true];
    $textos = ['text_es' => '', 'text_en' => '', 'text_fr' => '', 'text_de' => '', 'precio1' => '', 'precio2' => '', 'precio3' => '', 'empresa' => '', 'email_recepcion' => ''];

    $apiFile = $configDir . '/servidor_api.txt';
    if (file_exists($apiFile)) {
        $lines = file($apiFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if ($lines) {
            $keys = ['servidor', 'evento', 'evento_printer', 'timer', 'impresora', 'delay', 'servicio_disponible'];
            foreach ($lines as $i => $line) {
                if (!isset($keys[$i])) break;
                $val = trim(strpos($line, ';') !== false ? explode(';', $line, 2)[1] : $line);
                $key = $keys[$i];
                if ($key === 'servicio_disponible') {
                    $config[$key] = ($val !== '0');
                } elseif (in_array($key, ['timer', 'delay'])) {
                    $config[$key] = (int) $val;
                } else {
                    $config[$key] = $val;
                }
            }
        }
    }

    $textosFile = $configDir . '/textos.txt';
    if (file_exists($textosFile)) {
        $lines = file($textosFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if ($lines) {
            // Soportar claves cortas del archivo y claves largas del JSON
            $keyMap = ['es' => 'text_es', 'en' => 'text_en', 'fr' => 'text_fr', 'de' => 'text_de'];
            $validKeys = ['text_es','text_en','text_fr','text_de','precio1','precio2','precio3','empresa','email_recepcion'];

            foreach ($lines as $line) {
                $line = trim($line);
                if (strpos($line, ':') !== false) {
                    $parts = explode(':', $line, 2);
                    $shortKey = trim($parts[0]);
                    $val = trim($parts[1] ?? '');
                    $key = $keyMap[$shortKey] ?? $shortKey;
                } else {
                    $key = '';
                    $val = $line;
                }
                
                if (in_array($key, $validKeys)) {
                    $textos[$key] = $val;
                }
            }
        }
    }

    echo json_encode(['ok' => true, 'config' => $config, 'textos' => $textos, 'habitaciones' => readHabitaciones($configDir)]);
    exit();
}

// ── /print/* (simulados) ──
if ($uri === '/print/count')    { echo json_encode(['count' => 0]);          exit(); }
if ($uri === '/print/printers') { echo json_encode(['printers' => []]);       exit(); }
if ($uri === '/print/job')      { echo json_encode(['ok' => true, 'count' => 0]); exit(); }


// ── /printbox/* ──
if (strpos($uri, '/printbox/') === 0) {
    getCsrfToken();
    $csrf    = getCsrfToken();
    $headers = $csrf ? ['X-XSRF-TOKEN: ' . $csrf] : [];

    if ($uri === '/printbox/find-event') {
        $result = proxyPost($PRINTBOX_BASE . '/api/v1/events/find', $data, $headers);
        if ($result['error']) {
            http_response_code(500);
            echo json_encode(['error' => $result['error']]);
            exit();
        }
        $resp = json_decode($result['body'], true);
        if ($result['code'] === 200 && isset($resp['data']['uuid'])) {
            echo json_encode(['uuid' => $resp['data']['uuid']]);
        } else {
            http_response_code($result['code'] ?: 500);
            echo $result['body'] ?: json_encode(['error' => 'Sin respuesta del servidor']);
        }
        exit();
    }

    if ($uri === '/printbox/photos') {
        $page   = $_GET['page'] ?? 1;
        $result = proxyPost($PRINTBOX_BASE . '/api/v1/events/photos?page=' . $page, $data, $headers);
        http_response_code($result['code'] ?: 500);
        echo $result['body'] ?: json_encode(['error' => 'Sin respuesta']);
        exit();
    }

    if ($uri === '/printbox/photos-to-print') {
        $result = proxyPost($PRINTBOX_BASE . '/api/v1/events/photos_two', $data, $headers);
        http_response_code($result['code'] ?: 500);
        echo $result['body'] ?: json_encode(['error' => 'Sin respuesta']);
        exit();
    }

    if ($uri === '/printbox/otp/request') {
        $result = proxyPost($PRINTBOX_BASE . '/api/v1/otp/request', $data, $headers);
        http_response_code($result['code'] ?: 500);
        echo $result['body'] ?: json_encode(['error' => 'Sin respuesta']);
        exit();
    }

    if ($uri === '/printbox/otp/validate') {
        $result = proxyPost($PRINTBOX_BASE . '/api/v1/otp/validate', $data, $headers);
        http_response_code($result['code'] ?: 500);
        echo $result['body'] ?: json_encode(['error' => 'Sin respuesta']);
        exit();
    }

    if ($uri === '/printbox/photo-send') {
        $payload = [
            'event' => $data['event'] ?? '',
            'image' => $data['image'] ?? '',
            'times' => $data['times'] ?? 1,
            'name' => $data['name'] ?? ('photo-' . time()),
            'print' => isset($data['print']) ? $data['print'] : (!empty($data['times']) ? true : false),
        ];
        if (!empty($data['phone'])) {
            $payload['phone'] = $data['phone'];
        }
        if (!empty($data['orientation'])) {
            $payload['orientation'] = $data['orientation'];
        }

        $result = proxyPost($PRINTBOX_BASE . '/api/v1/events/photo/send', $payload, $headers);
        http_response_code($result['code'] ?: 500);
        echo $result['body'] ?: json_encode(['error' => 'Sin respuesta']);
        exit();
    }

    // POST /printbox/notify-order — avisa a recepción por e-mail (mail() nativo de IONOS,
    // sin SMTP/PHPMailer). No llama a Laravel: las miniaturas ya vienen en el body.
    if ($uri === '/printbox/notify-order') {
        $room = preg_replace('/^ev[-_]?/i', '', trim($data['room'] ?? ''));
        $items = $data['items'] ?? [];
        $total = $data['total'] ?? '0';
        $paymentMethod = $data['paymentMethod'] ?? '';

        // El hotel llega en ?hotel= (lo añade el móvil desde el QR); el email de
        // recepción se lee del textos.txt de ESE hotel.
        $configDir = getReadConfigDir();
        $emailTo = getHotelReceptionEmail($configDir);

        if (!$emailTo) {
            echo json_encode(['ok' => true, 'skipped' => true, 'reason' => 'Sin email de recepción configurado para este hotel']);
            exit();
        }

        $sent = sendRoomOrderEmail($emailTo, $room, $items, $total, $paymentMethod);
        echo json_encode(['ok' => (bool) $sent]);
        exit();
    }
}

// ── Proxy de imágenes (con HTTP + Reintentos + Caché) ──
if (strpos($uri, '/proxy-image/') === 0) {
    $imagePath = substr($uri, strlen('/proxy-image'));
    $imageUrl  = 'http://gestion.printboxweb.com' . $imagePath; // forzamos HTTP

    // Headers de caché agresivo (imágenes son estáticas)
    header('Cache-Control: public, max-age=31536000, immutable');
    header('Pragma: cache');
    header('Expires: ' . date('r', strtotime('+1 year')));

    // Reintentos con backoff exponencial
    $maxRetries = 3;
    $imageData = null;
    $contentType = 'application/octet-stream';
    
    for ($attempt = 1; $attempt <= $maxRetries; $attempt++) {
        $ch = curl_init($imageUrl);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT        => 20 + ($attempt * 5), // Aumentar timeout en cada reintento
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_USERAGENT      => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            CURLOPT_FAILONERROR    => false, // No fallar silenciosamente
        ]);
        $imageData   = curl_exec($ch);
        $httpCode    = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: 'application/octet-stream';
        $curlError   = curl_error($ch);
        curl_close($ch);

        // Si éxito (código 200), salir del loop de reintentos
        if ($httpCode === 200 && $imageData) {
            break;
        }

        // Si fallo y no es el último intento, esperar antes de reintentar
        if ($attempt < $maxRetries) {
            $backoffMs = 500 * ($attempt); // 500ms, 1s, 1.5s
            usleep($backoffMs * 1000);
        }
    }

    if ($imageData && $httpCode === 200) {
        header('Content-Type: ' . $contentType);
        echo $imageData;
    } else {
        http_response_code(503); // 503 en lugar de 404, así el navegador lo reintentará
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Imagen no disponible', 'attempt' => $attempt]);
    }
    exit();
}

// ── /process-payment (Square payment processing) ──
if ($uri === '/process-payment') {
    $data = json_decode(file_get_contents('php://input'), true);

    $square = getSquareCredentials(getConfigDir());
    if (!$square['accessToken']) {
        http_response_code(500);
        echo json_encode(['error' => 'Square no configurado en el servidor']);
        exit();
    }
    $SQUARE_ACCESS_TOKEN = $square['accessToken'];

    $amount = isset($data['amount']) ? intval($data['amount']) : 0;  // Ya viene en centavos desde el viewer
    $location = $data['location_id'] ?? $square['locationId'];

    if (!$data['token'] || $amount <= 0) {
        http_response_code(400);
        echo json_encode(['error' => 'token y amount son requeridos']);
        exit;
    }

    $payload = json_encode([
        "source_id" => $data['token'],
        "idempotency_key" => uniqid('pba_', true),
        "amount_money" => [
            "amount" => $amount,
            "currency" => ($data['currency'] ?? 'EUR')
        ],
        "location_id" => $location
    ]);

    $url = "https://connect.squareup.com/v2/payments";
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Bearer ' . $SQUARE_ACCESS_TOKEN,
        'Content-Type: application/json'
    ]);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    http_response_code($httpCode ?: 500);
    echo $response;
    exit();
}

// ── /paypal/config (Devuelve clientId para PayPal JS SDK) ──
if ($uri === '/paypal/config') {
    $paypal = getPaypalCredentials(getConfigDir());
    header('Content-Type: application/json');
    echo json_encode([
        'clientId' => $paypal['clientId'],
        'env' => $paypal['env'],
        'currency' => 'EUR',
    ]);
    exit();
}

// ── /paypal/create-order (Crea orden en PayPal) ──
if ($uri === '/paypal/create-order') {
    $data = json_decode(file_get_contents('php://input'), true);
    $paypal = getPaypalCredentials(getConfigDir());

    if (!$paypal['clientId'] || !$paypal['clientSecret']) {
        http_response_code(500);
        echo json_encode(['error' => 'PayPal no configurado en el servidor']);
        exit();
    }

    $amount = isset($data['amount']) ? number_format(floatval($data['amount']), 2, '.', '') : null;
    $currency = $data['currency'] ?? 'EUR';

    if (!$amount) {
        http_response_code(400);
        echo json_encode(['error' => 'amount es requerido']);
        exit();
    }

    $urlBase = $paypal['env'] === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    $url = "$urlBase/v2/checkout/orders";
    $payload = json_encode([
        'intent' => 'CAPTURE',
        'purchase_units' => [[
            'amount' => [
                'currency_code' => $currency,
                'value' => $amount,
            ],
        ]],
    ]);

    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Basic ' . base64_encode($paypal['clientId'] . ':' . $paypal['clientSecret']),
        'Content-Type: application/json',
    ]);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    http_response_code($httpCode ?: 500);
    echo $response;
    exit();
}

// ── /paypal/capture-order (Captura orden PayPal) ──
if ($uri === '/paypal/capture-order') {
    $data = json_decode(file_get_contents('php://input'), true);
    $paypal = getPaypalCredentials(getConfigDir());

    if (!$paypal['clientId'] || !$paypal['clientSecret']) {
        http_response_code(500);
        echo json_encode(['error' => 'PayPal no configurado en el servidor']);
        exit();
    }

    $orderId = $data['orderId'] ?? '';
    if (!$orderId) {
        http_response_code(400);
        echo json_encode(['error' => 'orderId es requerido']);
        exit();
    }

    $urlBase = $paypal['env'] === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    $url = "$urlBase/v2/checkout/orders/{$orderId}/capture";

    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Basic ' . base64_encode($paypal['clientId'] . ':' . $paypal['clientSecret']),
        'Content-Type: application/json',
    ]);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    http_response_code($httpCode ?: 500);
    echo $response;
    exit();
}

// Ruta antigua: /proxy.php?route=process-payment (deprecated, kept for backward compatibility)
if (($_GET['route'] ?? '') === 'process-payment') {
    $data = json_decode(file_get_contents('php://input'), true);

    $square = getSquareCredentials(getConfigDir());
    if (!$square['accessToken']) {
        http_response_code(500);
        echo json_encode(['error' => 'Square no configurado en el servidor']);
        exit();
    }
    $SQUARE_ACCESS_TOKEN = $square['accessToken'];

    $amount = isset($data['amount']) ? intval($data['amount']) : 0;  // Ya viene en centavos desde el viewer
    $location = $data['location_id'] ?? $square['locationId'];

    if (!$data['token'] || $amount <= 0) {
        http_response_code(400);
        echo json_encode(['error' => 'token y amount son requeridos']);
        exit;
    }

    $payload = json_encode([
        "source_id" => $data['token'],
        "idempotency_key" => uniqid('pba_', true),
        "amount_money" => [
            "amount" => $amount,
            "currency" => ($data['currency'] ?? 'EUR')
        ],
        "location_id" => $location
    ]);

    $url = "https://connect.squareup.com/v2/payments";
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Bearer ' . $SQUARE_ACCESS_TOKEN,
        'Content-Type: application/json'
    ]);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    http_response_code($httpCode ?: 500);
    echo $response;
    exit();
}

// ══════════════════════════════════════════════════════════════════════════
// ── SISTEMA DE CUPONES ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

// Clave secreta para firmar los códigos: aleatoria, generada una vez y guardada en
// config/coupon_secret.txt (fuera de git, protegida por config/.htaccess). Nunca
// hardcodeada en el código fuente.
function getCouponSecret() {
    $base = getConfigDir();
    $f = $base . '/coupon_secret.txt';
    if (is_file($f)) { $s = trim(@file_get_contents($f)); if ($s !== '') return $s; }
    $secret = bin2hex(random_bytes(32));
    if (!is_dir($base)) @mkdir($base, 0755, true);
    @file_put_contents($f, $secret);
    return $secret;
}

/**
 * Normaliza el código de evento (quita prefijo ev- / ev_)
 */
function normalizeCouponEvent($code) {
    return preg_replace('/^ev[-_]?/i', '', trim($code));
}

// Comprueba que $evento es una habitación registrada del hotel de la sesión — evita que
// el admin de un hotel genere/liste cupones para el evento de otro hotel.
function hotelOwnsRoom($base, $hotelId, $evento) {
    $habitaciones = readHabitaciones(resolveHotelDir($base, $hotelId));
    foreach ($habitaciones as $h) {
        if (($h['codigo'] ?? '') === $evento) return true;
    }
    return false;
}

/**
 * Devuelve la ruta del archivo JSON de cupones para un evento.
 * Formato: /config/cupones-{evento}.json
 */
function getCouponFile($evento) {
    $configDir = getConfigDir();
    $evento = preg_replace('/[^0-9a-zA-Z_-]/', '', $evento);
    return $configDir . '/cupones-' . $evento . '.json';
}

/**
 * Devuelve la ruta del archivo de log de cupones para un evento.
 */
function getCouponLogFile($evento) {
    $configDir = getConfigDir();
    $evento = preg_replace('/[^0-9a-zA-Z_-]/', '', $evento);
    return $configDir . '/cupones-log-' . $evento . '.txt';
}

/**
 * Lee el JSON de cupones. Devuelve array vacío si no existe.
 * Lee siempre desde $file (que puede ser el .lock durante el lock).
 */
function readCoupons($file) {
    if (!file_exists($file)) return [];
    $content = file_get_contents($file);
    $decoded = json_decode($content, true);
    return is_array($decoded) ? $decoded : [];
}

/**
 * Escribe el JSON de cupones en el archivo indicado.
 */
function writeCoupons($file, $coupons) {
    file_put_contents($file, json_encode($coupons, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

/**
 * Genera un código de cupón con firma HMAC para evitar falsificaciones.
 * Formato breve: XXXXXXX-YYY (6 chars aleatorios + 3 chars HMAC)
 */
function generateCouponCode() {
    $random = strtoupper(bin2hex(random_bytes(3))); // 6 chars hex
    $hmac   = strtoupper(substr(hash_hmac('sha256', $random, getCouponSecret()), 0, 3));
    return $random . '-' . $hmac;
}

/**
 * Verifica que el código de cupón tiene una firma HMAC válida.
 * Protege contra códigos inventados manualmente y sigue admitiendo códigos antiguos.
 */
function verifyCouponCode($code) {
    $parts = explode('-', $code);
    if (count($parts) !== 2) return false;
    [$random, $hmac] = $parts;

    $isLegacy = strlen($random) === 8 && strlen($hmac) === 4;
    $isShort = strlen($random) === 6 && strlen($hmac) === 3;
    if (!$isLegacy && !$isShort) return false;

    $expectedLength = $isLegacy ? 4 : 3;
    $expected = strtoupper(substr(hash_hmac('sha256', $random, getCouponSecret()), 0, $expectedLength));
    return hash_equals($expected, $hmac);
}

/**
 * Ejecuta una función con lock atómico sobre el archivo de cupones.
 * rename() en Linux/IONOS es atómico: solo un proceso gana.
 * Si el .lock tiene más de 30s (proceso muerto), se limpia automáticamente.
 */
function withCouponLock($couponFile, callable $fn) {
    $lockFile = $couponFile . '.lock';
    $timeout  = 4000; // ms máximo de espera
    $start    = microtime(true) * 1000;

    // Limpiar lock huérfano (proceso muerto hace más de 30s)
    if (file_exists($lockFile) && (time() - filemtime($lockFile)) > 30) {
        @rename($lockFile, $couponFile);
    }

    // Si el archivo aún no existe, crearlo vacío para poder renombrarlo
    if (!file_exists($couponFile)) {
        file_put_contents($couponFile, '{}');
    }

    // Intentar obtener el lock renombrando el archivo original a .lock
    while (!@rename($couponFile, $lockFile)) {
        if ((microtime(true) * 1000 - $start) > $timeout) {
            http_response_code(503);
            echo json_encode(['error' => 'Sistema ocupado, reintenta']);
            exit();
        }
        usleep(60000); // esperar 60ms antes de reintentar
    }

    try {
        $result = $fn($lockFile);
    } finally {
        // SIEMPRE desbloquear, aunque falle
        @rename($lockFile, $couponFile);
    }
    return $result;
}

/**
 * Escribe una línea en el log de uso de cupones.
 */
function logCouponUsage($evento, $code, $amount, $action) {
    $logFile = getCouponLogFile($evento);
    $ip      = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $line    = date('Y-m-d H:i:s') . " [$action] code=$code amount={$amount} ip=$ip\n";
    @file_put_contents($logFile, $line, FILE_APPEND | LOCK_EX);
}

// ── POST /coupon/create (Solo admin autenticado del hotel) ────────────────
if ($uri === '/coupon/create' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $base = getConfigDir();
    $sessionHotelId = getSessionHotelId($base);
    if (!$sessionHotelId) {
        http_response_code(401);
        echo json_encode(['error' => 'No autenticado']);
        exit();
    }

    $evento = normalizeCouponEvent($data['evento'] ?? '');
    $amount = intval($data['amount'] ?? 0); // en céntimos (ej: 500 = 5.00€)
    $expiresIn = intval($data['expires_hours'] ?? 72); // horas hasta caducar, default 72h
    $type = ($data['type'] ?? 'discount') === 'full' ? 'full' : 'discount';

    if (!$evento) {
        http_response_code(400);
        echo json_encode(['error' => 'evento requerido']);
        exit();
    }
    if ($amount <= 0) {
        http_response_code(400);
        echo json_encode(['error' => 'amount debe ser mayor que 0 (en céntimos)']);
        exit();
    }
    if (!hotelOwnsRoom($base, $sessionHotelId, $evento)) {
        http_response_code(403);
        echo json_encode(['error' => 'Esa habitación no pertenece a tu hotel']);
        exit();
    }

    $code = generateCouponCode();
    $now  = time();

    $couponFile = getCouponFile($evento);
    withCouponLock($couponFile, function($lockFile) use ($code, $amount, $now, $expiresIn, $type) {
        $coupons = readCoupons($lockFile);
        $coupons[$code] = [
            'amount'     => $amount,
            'type'       => $type,
            'status'     => 'active',
            'created_at' => date('c', $now),
            'expires_at' => date('c', $now + ($expiresIn * 3600)),
            'used_at'    => null,
            'used_by_ip' => null,
            'used_order' => null,
        ];
        writeCoupons($lockFile, $coupons);
    });

    logCouponUsage($evento, $code, $amount, 'CREATE');

    echo json_encode([
        'ok'     => true,
        'code'   => $code,
        'amount' => $amount,
        'type'   => $type,
        'amount_eur' => number_format($amount / 100, 2, '.', '') . '€',
        'expires_at' => date('c', $now + ($expiresIn * 3600)),
    ]);
    exit();
}

// ── POST /coupon/validate (Solo comprueba, no consume) ────────────────────
if ($uri === '/coupon/validate' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $evento = normalizeCouponEvent($data['evento'] ?? '');
    $code   = strtoupper(trim($data['code'] ?? ''));

    if (!$evento || !$code) {
        http_response_code(400);
        echo json_encode(['error' => 'evento y code requeridos']);
        exit();
    }

    // Verificar firma HMAC primero (evita leer el archivo para códigos inventados)
    if (!verifyCouponCode($code)) {
        http_response_code(422);
        echo json_encode(['valid' => false, 'error' => 'Código de cupón inválido']);
        exit();
    }

    $couponFile = getCouponFile($evento);
    $coupons    = readCoupons($couponFile);

    if (!isset($coupons[$code])) {
        http_response_code(422);
        echo json_encode(['valid' => false, 'error' => 'Cupón no encontrado']);
        exit();
    }

    $coupon = $coupons[$code];

    if ($coupon['status'] !== 'active') {
        http_response_code(422);
        echo json_encode(['valid' => false, 'error' => 'Cupón ya utilizado']);
        exit();
    }

    if (strtotime($coupon['expires_at']) < time()) {
        http_response_code(422);
        echo json_encode(['valid' => false, 'error' => 'Cupón caducado']);
        exit();
    }

    echo json_encode([
        'valid'      => true,
        'amount'     => $coupon['amount'],
        'type'       => $coupon['type'] ?? 'discount',
        'amount_eur' => number_format($coupon['amount'] / 100, 2, '.', '') . '€',
        'expires_at' => $coupon['expires_at'],
    ]);
    exit();
}

// ── POST /coupon/redeem (Consume el cupón — llamar solo tras pago exitoso) ─
if ($uri === '/coupon/redeem' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $evento   = normalizeCouponEvent($data['evento'] ?? '');
    $code     = strtoupper(trim($data['code'] ?? ''));
    $orderId  = $data['order_id'] ?? '';

    if (!$evento || !$code) {
        http_response_code(400);
        echo json_encode(['error' => 'evento y code requeridos']);
        exit();
    }

    // Verificar firma HMAC
    if (!verifyCouponCode($code)) {
        http_response_code(422);
        echo json_encode(['ok' => false, 'error' => 'Código de cupón inválido']);
        exit();
    }

    $couponFile = getCouponFile($evento);
    $result = withCouponLock($couponFile, function($lockFile) use ($code, $orderId) {
        $coupons = readCoupons($lockFile);

        if (!isset($coupons[$code])) {
            return ['ok' => false, 'error' => 'Cupón no encontrado', 'http' => 422];
        }

        $coupon = $coupons[$code];

        if ($coupon['status'] !== 'active') {
            return ['ok' => false, 'error' => 'Cupón ya utilizado', 'http' => 422];
        }

        if (strtotime($coupon['expires_at']) < time()) {
            return ['ok' => false, 'error' => 'Cupón caducado', 'http' => 422];
        }

        // Marcar como usado
        $coupons[$code]['status']     = 'used';
        $coupons[$code]['used_at']    = date('c');
        $coupons[$code]['used_by_ip'] = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
        $coupons[$code]['used_order'] = $orderId;

        writeCoupons($lockFile, $coupons);

        return ['ok' => true, 'amount' => $coupon['amount']];
    });

    if (!$result['ok']) {
        http_response_code($result['http'] ?? 422);
        echo json_encode($result);
        exit();
    }

    logCouponUsage($evento, $code, $result['amount'], 'REDEEM');

    echo json_encode([
        'ok'     => true,
        'amount' => $result['amount'],
        'amount_eur' => number_format($result['amount'] / 100, 2, '.', '') . '€',
    ]);
    exit();
}

// ── GET /coupon/list (Panel admin — lista cupones de un evento) ────────────
if ($uri === '/coupon/list' && $_SERVER['REQUEST_METHOD'] === 'GET') {
    $base = getConfigDir();
    $sessionHotelId = getSessionHotelId($base);
    if (!$sessionHotelId) {
        http_response_code(401);
        echo json_encode(['error' => 'No autenticado']);
        exit();
    }

    $evento = normalizeCouponEvent($_GET['evento'] ?? '');

    if (!$evento) {
        http_response_code(400);
        echo json_encode(['error' => 'evento requerido']);
        exit();
    }
    if (!hotelOwnsRoom($base, $sessionHotelId, $evento)) {
        http_response_code(403);
        echo json_encode(['error' => 'Esa habitación no pertenece a tu hotel']);
        exit();
    }

    $couponFile = getCouponFile($evento);
    $coupons    = readCoupons($couponFile);

    // Añadir info derivada a cada cupón para el panel
    $list = [];
    foreach ($coupons as $code => $c) {
        $list[] = array_merge($c, [
            'code'       => $code,
            'amount_eur' => number_format($c['amount'] / 100, 2, '.', '') . '€',
            'expired'    => strtotime($c['expires_at']) < time(),
        ]);
    }

    // Ordenar: activos primero, luego por fecha de creación desc
    usort($list, function($a, $b) {
        if ($a['status'] !== $b['status']) {
            return $a['status'] === 'active' ? -1 : 1;
        }
        return strcmp($b['created_at'], $a['created_at']);
    });

    echo json_encode(['ok' => true, 'evento' => $evento, 'coupons' => $list]);
    exit();
}

// ══════════════════════════════════════════════════════════════════════════
// ── FIN SISTEMA DE CUPONES ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

http_response_code(404);
echo json_encode(['error' => 'Ruta no encontrada', 'uri' => $uri]);