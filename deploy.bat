@echo off
echo Deploying to Cloudflare Pages production...
npx wrangler pages deploy . --project-name=solara --branch=master
echo Done! Visit https://music.luoxi.me to test.
