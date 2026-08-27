#!/usr/bin/env node
require('dotenv').config();
const readline = require('readline');
const { pool } = require('../src/db');
const usersRepo = require('../src/repo/users');

/**
 * Account management, from the command line only.
 *
 * There is no "create an account" page and no self-service sign-up, on purpose.
 * This dashboard has a fixed, small set of people who are allowed to see other
 * people's CVs and salaries; a registration form on a public host is an open
 * door with a form in front of it. Adding somebody is a deliberate act by
 * whoever runs the server.
 *
 *   npm run users -- list
 *   npm run users -- add    you@example.com "Your Name"
 *   npm run users -- passwd you@example.com
 *   npm run users -- disable you@example.com
 *   npm run users -- enable  you@example.com
 *
 * The password is never taken as an argument. Anything on a command line ends
 * up in the shell history and in the process list, where any other user on the
 * box can read it, so it is always prompted for.
 */

/** Reads a line with the terminal echo off, so the password is not on screen. */
function prompt(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (silent) {
      // Suppress the echo without suppressing the prompt itself: readline writes
      // the question through the same stream it is muting, so the question is
      // written first and only what the user types is swallowed.
      const output = rl.output;
      rl._writeToOutput = (str) => {
        if (str.includes(question)) output.write(str);
      };
    }
    rl.question(question, (answer) => {
      if (silent) rl.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function readPassword() {
  const first = await prompt('Password: ', { silent: true });
  // A short password on an internet-facing login is the weak link in
  // everything else here — the scrypt cost buys nothing against "abc123".
  if (first.length < 10) {
    throw new Error('Use at least 10 characters. A passphrase is easier and stronger.');
  }
  const second = await prompt('Confirm: ', { silent: true });
  // Confirmed because it is never displayed. A typo in a password you cannot
  // see locks you out of an account you just created, with nothing to look at
  // to work out why.
  if (first !== second) throw new Error('They did not match. Nothing was changed.');
  return first;
}

async function main() {
  const [command, email, name] = process.argv.slice(2);

  switch (command) {
    case 'list': {
      const users = await usersRepo.list();
      if (users.length === 0) {
        console.log('No accounts yet. Add one with:  npm run users -- add you@example.com "Your Name"');
        break;
      }
      for (const u of users) {
        const state = u.disabled_at ? 'disabled' : 'active';
        const seen = u.last_login_at
          ? new Date(u.last_login_at).toISOString().slice(0, 16).replace('T', ' ')
          : 'never';
        console.log(`${u.email.padEnd(32)} ${u.name.padEnd(24)} ${state.padEnd(9)} last login ${seen}`);
      }
      break;
    }

    case 'add': {
      if (!email || !name) throw new Error('Usage: npm run users -- add <email> "<name>"');
      const plain = await readPassword();
      const user = await usersRepo.create({ email, name, password: plain });
      console.log(`Added ${user.email} (${user.name}). They can sign in now.`);
      break;
    }

    case 'passwd': {
      if (!email) throw new Error('Usage: npm run users -- passwd <email>');
      const plain = await readPassword();
      const user = await usersRepo.setPassword(email, plain);
      if (!user) throw new Error(`No account for ${email}.`);
      // Existing sessions are left alone deliberately: changing your own
      // password should not sign you out of the browser you are typing it in.
      // Use `disable` then `enable`, or logout-everywhere in the app, to end
      // sessions on a password you believe was compromised.
      console.log(`Password changed for ${user.email}. Existing sessions still work.`);
      break;
    }

    case 'disable': {
      if (!email) throw new Error('Usage: npm run users -- disable <email>');
      const user = await usersRepo.setDisabled(email, true);
      if (!user) throw new Error(`No account for ${email}.`);
      console.log(`${user.email} is disabled and signed out everywhere.`);
      break;
    }

    case 'enable': {
      if (!email) throw new Error('Usage: npm run users -- enable <email>');
      const user = await usersRepo.setDisabled(email, false);
      if (!user) throw new Error(`No account for ${email}.`);
      console.log(`${user.email} can sign in again.`);
      break;
    }

    default:
      console.log(`Usage:
  npm run users -- list
  npm run users -- add <email> "<name>"
  npm run users -- passwd <email>
  npm run users -- disable <email>
  npm run users -- enable <email>`);
      process.exitCode = command ? 1 : 0;
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err.message);
    await pool.end();
    process.exit(1);
  });
