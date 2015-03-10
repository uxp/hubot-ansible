// Description:
//   Run Ansible playbooks and manage inventory through Hubot
//
// Dependencies:
//   "redis": "^0.8.4"
//
// Configuration:
//   HUBOT_ANSIBLE_PATH: path to your ansible playbooks
//
// Commands:
//   hubot ansible playbook <playbook> <tag, [tag]> - runs <playbook> with <tags>
//   hubot ansible inventory add <host> <group> <vars> - Adds <host> to the <group> with the given <vars> (in "key=val" format)
//   hubot ansible inventory del <name> - Removes the given inventory record with a group or hostname of <name>
//   hubot ansible inventory list - Lists saved Ansible inventory in api format
//   hubot ansible inventory host <hostname> - Returns a dictionary of variables for the given <hostname>
//
// Author:
//   uxp <howard@hplogsdon.com>

module.exports = (function() {
    "use strict";

    var path = require('path'),
        fs = require('fs'),
        URL = require('url'),
        child = require('child_process'),
        Redis = require('redis');

    return function(robot) {
        var inventory = Object.create(null),
            ansible_playbooks_path = (process.env.HUBOT_ANSIBLE_PATH || path.join(__dirname, '..', 'playbooks')),
            ansible_log_path = (process.env.HUBOT_ANSIBLE_LOG || path.join(__dirname, '..', 'ansible.log')),
            url = URL.parse(process.env.REDIS_URL || 'redis://localhost:6379'),
            redis = Redis.createClient(url.port, url.hostname),
            prefix = ((url.path || 'hubot').replace('/', '') + ':ansible'),
            loadInventory = function() {
                redis.get(prefix + ':inventory', function(err, res) {
                    if (err) throw err;
                    inventory = JSON.parse((res || "{}").toString());
                    autosaveInterval(5);
                });
            },
            autosave = undefined,
            autosaveInterval = function(seconds) {
                if (autosave) clearInterval(autosave);
                if (seconds > 0) {
                    autosave = setInterval(function() {
                        redis.set(prefix + ':inventory', JSON.stringify(inventory));
                    }, seconds * 1000);
                }
            };


        if (url.auth) {
            redis.auth(url.auth.split(":")[1], function(err) {
                if (err) {
                    robot.logger.error("ansible: Failed to authenticate to Redis");
                } else {
                    loadInventory();
                }
            });
        };

        redis.on("error", function(err) {
            autosaveInterval(0);
            if (!(/ECONNREFUSED/.test(err.message))) {
                robot.logger.error(err.stack);
            }
            throw err;
        });

        redis.on("connect", function() {
            autosaveInterval(0);
            if (!url.auth) loadInventory();
        });

        robot.respond(/ansible playbook ([0-9a-zA-Z\-_]+)((?:\s+)(.*))?$/i, function(msg) {
            var playbook = msg.match[1],
                tags = (msg.match[2] || "").trim().split(" "),
                ansible = ("ansible-playbook " + playbook + ".yml -vvvv"),
                options = { cwd: ansible_playbooks_path };

            if (tags.length && tags[0] === "") tags = [];

            if (tags.length)
                ansible += " --tags='" + tags.join(",") + "'";

            ansible += " --inventory-file=" + path.join(__dirname, '..', 'bin', 'inventory');

            msg.send("Running " + playbook + ".yml" + (tags.length ? " with tags: "+ tags.join(',') : ""));
            robot.logger.info("Executing: " + ansible);
            child.exec(ansible, options, function(error,stdout,stderr) {
                if (error)
                    robot.logger.error(stderr);

                fs.writeFile(ansible_log_path, stdout, function(err) {
                    if (err) {
                        msg.reply("I ran into an error running " + playbook +". Check the ansible.log file");
                    }
                });
                var idx = stdout.lastIndexOf("PLAY RECAP"),
                    recap = stdout.slice(idx);

                msg.send(recap)
            });
        });

        robot.respond(/ansible inventory add ([0-9a-zA-Z\-_\.]+)(?:\s+)([\w\-]+)(?:\s+)(.*)$/i, function(msg) {
            // http://docs.ansible.com/developing_inventory.html
            var host = msg.match[1],
                group = msg.match[2],
                vars = msg.match[3];

            if (!inventory[group]) inventory[group] = {
                hosts: new Array(),
                vars: Object.create(null),
                children: new Array()
            };

            if (inventory[group]['hosts'].indexOf(host) === -1)
                inventory[group]['hosts'].push(host);

            vars.split(" ").forEach(function(varPair) {
                var pair = varPair.split("=");

                inventory[group]['vars'][pair[0]] = pair[1];
                msg.reply("Added host '" + host + "' to group '" + group + "'.");
            });
        });

        robot.respond(/ansible inventory del ([0-9a-zA-Z\-_\.]+)/i, function(msg) {
            var name = msg.match[1];
            inventory[name] = undefined;
            msg.reply("Removed group '" + name  + "' from inventory");
        });
        robot.respond(/ansible inventory list/i, function(msg) {
            msg.send(JSON.stringify(inventory));
        });

        robot.respond(/ansible inventory host ([0-9a-zA-Z\-_\.]+)/i, function(msg) {
            // not implemented yet...
            msg.send("{}");
        });
    };

}).call(this);
