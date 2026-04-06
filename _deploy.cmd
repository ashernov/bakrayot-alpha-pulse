@echo off
cd /d C:\Asher\Alpha-Pulse
node_modules\.bin\wrangler.cmd deploy > _deploy_out.txt 2>&1
echo EXIT:%ERRORLEVEL% >> _deploy_out.txt
