#!/bin/sh
# Flax 自己的 macOS 签名证书（自签名，只用来签代码），跟 Folio 的做法一样。
#
# macOS 按签名认应用：同一张证书签的每个版本都是"同一个应用"，自动更新才装得上，
# 钥匙串里的 API Key 也不会每次更新都重新问。不需要苹果开发者账号。
#
# 在 ~/.flax-signing/ 生成一次证书，放进登录钥匙串（名字 "Flax Code Signing"），本机打包就会用它签。
# 每台打包的 Mac 自己运行一次。GitHub 上自动打包也要用，把它加进仓库的 secrets：
#   base64 -i ~/.flax-signing/macos.p12 | gh secret set MAC_CERTIFICATE -R linlih/flax
#   gh secret set MAC_CERTIFICATE_PASSWORD -R linlih/flax < ~/.flax-signing/macos-password.txt
# 备份好 ~/.flax-signing/：换一张证书，macOS 就当成另一个应用，旧版本也不能自动更新过来。
set -eu

dir="${FLAX_SIGNING_DIR:-$HOME/.flax-signing}"
name="Flax Code Signing"
mkdir -p "$dir"
chmod 700 "$dir"
umask 077

if [ ! -f "$dir/macos.p12" ]; then
  conf=$(mktemp)
  cat > "$conf" <<CNF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $name
O = Flax
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF
  openssl rand -base64 24 | tr -d '\n' > "$dir/macos-password.txt"
  openssl req -x509 -newkey rsa:3072 -sha256 -days 10000 -nodes -keyout "$dir/macos.key" -out "$dir/macos.pem" -config "$conf"
  openssl pkcs12 -export -legacy -inkey "$dir/macos.key" -in "$dir/macos.pem" -name "$name" -out "$dir/macos.p12" -passout "file:$dir/macos-password.txt"
  rm -f "$conf"
fi

if security find-identity -p codesigning | grep -q "\"$name\""; then
  echo "\"$name\" 已经在钥匙串里了。"
else
  # 只让 codesign 不用询问就能用这把私钥
  security import "$dir/macos.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$(cat "$dir/macos-password.txt")" -T /usr/bin/codesign
fi
security find-identity -p codesigning | grep "\"$name\""
