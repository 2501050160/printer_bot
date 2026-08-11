#!/usr/bin/env bash
echo "Starting Cloud Print Kiosk - Print Agent..."
cd "$(dirname "$0")"
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi
npm start
