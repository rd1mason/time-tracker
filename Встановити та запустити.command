#!/bin/bash
cd "$(dirname "$0")"

# Find node
NODE=""
for p in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | tail -1)/bin/node" /opt/local/bin/node; do
  if [ -f "$p" ]; then NODE="$p"; break; fi
done

if [ -z "$NODE" ]; then
  # Try from PATH (user might have opened new terminal after install)
  NODE=$(which node 2>/dev/null)
fi

if [ -z "$NODE" ]; then
  echo "❌ Node.js не знайдено. Відкрий nodejs.org і встанови LTS версію, потім запусти цей файл знову."
  read -p "Натисни Enter щоб вийти..."
  exit 1
fi

NPM=$(dirname "$NODE")/npm
echo "✅ Node.js знайдено: $NODE"
echo "📦 Встановлюю залежності (перший раз ~2-3 хв)..."
"$NPM" install

echo "🚀 Запускаю Time Tracker..."
"$(dirname "$NODE")/npx" electron .
