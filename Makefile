.PHONY: install frontend build check

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

check:
	cd frontend && npx esbuild scripts/check-device-cohort.ts --bundle --platform=node --format=esm --outfile=.check/device-cohort.mjs --alias:@=./src --log-level=warning && node .check/device-cohort.mjs
