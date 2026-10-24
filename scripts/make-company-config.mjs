#!/usr/bin/env node
// Makes build/company.json: the organization's IAM Identity Center sign-in for `pnpm dist` to bake into the app
// (electron-builder.config.cjs ships it as Resources/company.json, src/main/setup.ts reads it, and a first run offers
// "Sign in to <name> AWS"). It takes one sso-session and the profiles that use it from ~/.aws/config, and their labels
// and colours from this Mac's app settings. Never credentials: ~/.aws/credentials is not opened. build/company.json is
// gitignored; a build without it is generic.
//
//   node --experimental-strip-types scripts/make-company-config.mjs --name Mainspring [--session mainspring]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_FILE, listSectionHeaders, readSection } from '../src/main/aws/awsfiles.ts'
import { awsSetupFrom, parseCompanySetup } from '../src/shared/setup.ts'

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined }
const config = Object.fromEntries(listSectionHeaders(CONFIG_FILE).map((h) => [h, readSection(CONFIG_FILE, h) ?? {}]))
const { aws } = awsSetupFrom(config)
if (!aws.sessions.length) throw new Error(`No sso-session in ${CONFIG_FILE}: sign in with Add AWS account first.`)
const session = arg('--session') ?? aws.sessions[0].name
const chosen = aws.sessions.find((s) => s.name === session)
if (!chosen) throw new Error(`No sso-session "${session}" in ${CONFIG_FILE} (there is ${aws.sessions.map((s) => s.name).join(', ')}).`)
const name = arg('--name') ?? session.charAt(0).toUpperCase() + session.slice(1)
const profiles = aws.profiles.filter((p) => p.session === session)

const settingsFile = join(homedir(), 'Library', 'Application Support', 'EC2 Remote Access', 'ec2-remote-access.json')
const meta = existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, 'utf8')).settings?.accountMeta ?? {}) : {}
const accountMeta = Object.fromEntries(profiles.filter((p) => meta[p.name]).map((p) => [p.name, { label: meta[p.name].label, color: meta[p.name].color }]))

const company = { name, aws: { sessions: [chosen], profiles }, accountMeta }
// The app reads it with the same checks, so a file it would refuse is never written.
parseCompanySetup(JSON.stringify(company))
writeFileSync('build/company.json', `${JSON.stringify(company, null, 2)}\n`)
console.log(`build/company.json: "${name}", sign-in ${session} (${chosen.region}), profiles ${profiles.map((p) => p.name).join(', ')}`)
