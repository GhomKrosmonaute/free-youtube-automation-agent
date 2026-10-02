// What alerts that need a human (expert review, a reactive video to approve) share: who they ping, how a Discord
// webhook is recognised, and where they go.

// Who an alert pings so it reaches a phone: EXPERT_REVIEW_MENTION holds Discord user ids (bare or <@id>), roles
// (<@&id>) or @here / @everyone, separated by spaces or commas; anything else (a Slack <@U...>) is kept as written.
function mention() {
  const ping = { tags: [], users: [], roles: [], everyone: false };
  for (const token of String(process.env.EXPERT_REVIEW_MENTION || '').split(/[\s,]+/).filter(Boolean)) {
    const role = token.match(/^<@&(\d+)>$/);
    const user = token.match(/^(?:<@[!:]?)?(\d{15,25})>?$/);
    if (role) {
      ping.roles.push(role[1]);
      ping.tags.push(`<@&${role[1]}>`);
    } else if (user) {
      ping.users.push(user[1]);
      ping.tags.push(`<@${user[1]}>`);
    } else {
      if (['@here', '@everyone'].includes(token)) ping.everyone = true;
      ping.tags.push(token);
    }
  }
  return ping;
}

// Discord pings only the configured mention, never an @everyone that slipped into quoted text.
function allowedMentions(ping = mention()) {
  return { parse: ping.everyone ? ['everyone'] : [], users: ping.users, roles: ping.roles };
}

function discordWebhook(url) {
  return /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(url);
}

// The channel the operator watches for decisions to take.
function alertWebhookUrl() {
  return String(process.env.EXPERT_REVIEW_WEBHOOK_URL || process.env.NOTIFICATION_WEBHOOK_URL || '').trim();
}

// Discord markdown would read * _ ~ ` | in a title or a quoted sentence as formatting.
const md = value => String(value ?? '').replace(/\s+/g, ' ').replace(/([\\*_~`|])/g, '\\$1');

module.exports = { mention, allowedMentions, discordWebhook, alertWebhookUrl, md };
