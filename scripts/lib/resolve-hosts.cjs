// Preloaded with `node --require`: answers dns.lookup for the hosts ABER_RESOLVE names
// (`host=address,host=address`) with those addresses, and every other name as usual. It lets a
// client that takes only a URL reach a host no resolver answers, such as the site rehearsal's
// domain through a port-forward, without editing the machine's hosts file.
const dns = require('node:dns')
const process = require('node:process')

const answers = new Map((process.env.ABER_RESOLVE || '')
  .split(',').filter(Boolean).map(pair => pair.split('=').map(s => s.trim())))
const systemLookup = dns.lookup

dns.lookup = function lookup (hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  const address = answers.get(hostname)
  if (!address) return systemLookup.call(dns, hostname, options, callback)
  const family = address.includes(':') ? 6 : 4
  // net asks with `all: true` when it races address families (autoSelectFamily).
  if (typeof options === 'object' && options?.all) return process.nextTick(callback, null, [{ address, family }])
  return process.nextTick(callback, null, address, family)
}
