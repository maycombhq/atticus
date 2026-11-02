// Adds the overdraft limit the portal shows, from a lookup the proxy makes.
var body = JSON.parse(context.getVariable("response.content"));
body.data.overdraftLimit = lookupLimit(context.getVariable("forge.id"));
context.setVariable("response.content", JSON.stringify(body));
