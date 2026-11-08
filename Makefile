SHELL := /bin/bash

APP ?= /Applications/ChatGPT.app
ASAR ?= $(APP)/Contents/Resources/app.asar
# Node.js for the tooling and the host; defaults to the one Codex ships.
NODE ?= $(firstword $(wildcard $(APP)/Contents/Resources/cua_node/bin/node /Applications/Codex.app/Contents/Resources/cua_node/bin/node) node)
CLI = "$(NODE)" scripts/codex_mod.mjs
WATCHER := build/launch-watcher
# The Codex home the mod works in. Unset, it is the one the installed agent
# runs with, so later targets stay in the home `make install CODEX_HOME=...`
# chose; without either, Codex's default ~/.codex.
ifeq ($(origin CODEX_HOME),undefined)
CODEX_HOME := $(shell $(CLI) codex-home 2>/dev/null)
endif
ifneq ($(strip $(CODEX_HOME)),)
export CODEX_HOME
endif

.DEFAULT_GOAL := dry-run

.PHONY: dry-run test install host uninstall on off status repair-rollouts release-archive

define validate
	for file in scripts/*.mjs scripts/*.cjs dev/*.mjs; do "$(NODE)" --check "$$file" || exit 1; done
endef

$(WATCHER): scripts/launch_watcher.m
	mkdir -p $(dir $@)
	clang -fobjc-arc -framework AppKit -O2 -o $@ $<

# Validates the patches against the installed Codex build without writing
# anything outside a temporary directory.
dry-run:
	$(validate)
	$(CLI) dry-run --asar "$(ASAR)"

test:
	$(validate)
	"$(NODE)" --test tests/*.test.mjs

# Installs the launch agent that runs the host from this checkout. A
# development install never updates itself; the one-line installer in the
# README sets up the release install users run.
install: $(WATCHER)
	$(validate)
	$(CLI) install --asar "$(ASAR)" --node "$(NODE)"

# Runs the host in the foreground for development. Stop the launch agent
# first, otherwise two hosts compete for the same Codex instance.
host: $(WATCHER)
	$(validate)
	CODEX_MOD_DEVELOPMENT=1 "$(NODE)" scripts/codex_mod_host.mjs

# Turns the mod off and on without uninstalling it, for example to compare
# with stock Codex during development. Off keeps the agent installed but
# disabled, also across logins, and restarts a running Codex without the mod;
# on lets the host relaunch it with the mod. Saved logins and the renderer
# cache stay in place.
off:
	$(CLI) off --app "$(APP)"

on:
	$(CLI) on

status:
	$(CLI) status

uninstall:
	$(CLI) uninstall --asar "$(ASAR)"

# Renumbers rollout segments whose ordinals stopped increasing so Codex shows
# their hidden turns again. Quit Codex first; the host runs the same scan on
# its own whenever Codex is not running. REPAIR_ARGS=--dry-run only reports.
repair-rollouts:
	"$(NODE)" --check scripts/rollout_repair.cjs
	"$(NODE)" scripts/rollout_repair.cjs --all $(REPAIR_ARGS)

# Builds what a release publishes into dist/, as the release workflow does:
# make release-archive VERSION=5.0.0
release-archive:
	"$(NODE)" dev/build_release.mjs "$(VERSION)" dist
