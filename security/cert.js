// 证书生成模块：自签名的服务器叶子证书（无 CA 架构）
// 设计要点（安全审计 H2 修复）：
//   - 不再生成 CA，磁盘上不存在带 keyCertSign 的万能密钥
//   - cA=false + 仅 digitalSignature/keyEncipherment，私钥泄露也只能假冒本站
//   - 有效期 397 天，SAN 覆盖 localhost + 全部本机 IPv4
// 依赖：node-forge、fs、path、os

const forge = require('node-forge');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CERT_VERSION = 2;

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function getAllLocalIPs() {
  const ips = ['localhost', '127.0.0.1'];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

function initCerts() {
  const localIP = getLocalIP();
  const allLocalIPs = getAllLocalIPs();

  const certDir = path.join(__dirname, 'certs');
  if (!fs.existsSync(certDir)) fs.mkdirSync(certDir);

  const serverCertPath = path.join(certDir, 'chatroom-server.crt');
  const serverKeyPath = path.join(certDir, 'chatroom-server.key');
  const versionPath = path.join(certDir, 'cert-version.txt');

  let serverCertPem, serverKeyPem;

  const versionOk = fs.existsSync(versionPath) &&
    fs.readFileSync(versionPath, 'utf8').trim() === String(CERT_VERSION);

  if (versionOk && fs.existsSync(serverCertPath) && fs.existsSync(serverKeyPath)) {
    console.log('检测到已有证书，直接使用...');
    serverCertPem = fs.readFileSync(serverCertPath, 'utf8');
    serverKeyPem = fs.readFileSync(serverKeyPath, 'utf8');
  } else {
    console.log('正在生成自签名服务器证书（叶子证书，cA=false）...');

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = Date.now().toString(16) + forge.util.bytesToHex(forge.random.getBytesSync(8));
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 397 * 24 * 3600 * 1000);

    const attrs = [
      { name: 'commonName', value: 'Chat Room Server' },
      { name: 'organizationName', value: 'Chat Room' }
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    const altNames = [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      { type: 7, ip: localIP }
    ];
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal && net.address !== localIP) {
          altNames.push({ type: 7, ip: net.address });
        }
      }
    }

    cert.setExtensions([
      { name: 'subjectAltName', altNames },
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectKeyIdentifier' }
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    serverCertPem = forge.pki.certificateToPem(cert);
    serverKeyPem = forge.pki.privateKeyToPem(keys.privateKey);

    // 清理 v1 架构遗留的 CA 文件（含明文 CA 私钥）
    for (const legacy of ['chatroom-ca.crt', 'chatroom-ca.key']) {
      try { fs.unlinkSync(path.join(certDir, legacy)); } catch {}
    }

    fs.writeFileSync(serverCertPath, serverCertPem);
    fs.writeFileSync(serverKeyPath, serverKeyPem);
    fs.writeFileSync(versionPath, String(CERT_VERSION));

    console.log('证书已生成并保存到 certs/ 目录');
  }

  return {
    serverCertPem,
    serverKeyPem,
    caCertPem: serverCertPem,
    caKeyPem: null,
    caCertPath: serverCertPath,
    localIP,
    allLocalIPs
  };
}

module.exports = { initCerts, getLocalIP, getAllLocalIPs };
