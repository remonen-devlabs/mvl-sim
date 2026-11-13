@echo off
rem MVL Sim: starts the ride emulator and opens it in the browser.
rem Double-click this file, or run it with project folders:  start.cmd C:\path\to\my-datafield
rem Close the window to stop the emulator.
title MVL Sim
node "%~dp0server.mjs" --open %*
if errorlevel 1 pause
