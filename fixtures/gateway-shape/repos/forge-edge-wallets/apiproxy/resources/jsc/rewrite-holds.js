// The module names holds "blocks": /accounts/{id}/holds becomes /accounts/{id}/blocks.
var suffix = context.getVariable("proxy.pathsuffix");
context.setVariable("target.copy.pathsuffix", false);
var rewritten = suffix.replace(/\/holds$/, "/blocks");
context.setVariable("target.url", context.getVariable("target.url") + rewritten);
