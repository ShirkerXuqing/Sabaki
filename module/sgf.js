var Tuple = require('../lib/tuple')

var gametree = require('../module/gametree')
var fs = require('fs')

var alpha = 'abcdefghijklmnopqrstuvwxyz'

exports.meta = {
    name: 'Smart Game Format',
    extensions: ['sgf']
}

exports.tokenize = function(input) {
    var tokens = []
    var dict = {
        ignore: /^\s+/,
        parenthesis: /^(\(|\))/,
        semicolon: /^;/,
        prop_ident: /^[A-Za-z]+/,
        c_value_type: /^\[(\]|[^]*?[^\\]\])/
    }

    while (input.length > 0) {
        var token = null
        var length = 0

        for (var name in dict) {
            var matches = dict[name].exec(input)
            if (!matches) continue

            var value = matches[0]
            length = value.length

            if (name == 'c_value_type')
                value = exports.unescapeString(value.substr(1, length - 2))
            token = new Tuple(name, value)

            break
        }

        if (token && token[0] != 'ignore') tokens.push(token)
        input = input.substr(length)
    }

    return tokens
}

exports.parse = function(tokens, callback, start, depth) {
    if (!callback) callback = function(progress) {}
    if (!start) start = [0]
    if (isNaN(depth)) depth = 0

    var i = start[0]
    var node, property, tree = gametree.new()
    tree.collapsed = tokens.length >= setting.get('graph.collapse_tokens_count')
        && depth >= setting.get('graph.collapse_min_depth')

    while (i < tokens.length) {
        if (new Tuple('parenthesis', '(').equals(tokens[i])) break
        if (new Tuple('parenthesis', ')').equals(tokens[i])) return tree

        tokens[i].unpack(function(type, data) {
            if (type == 'semicolon') {
                node = {}
                tree.nodes.push(node)
            } else if (type == 'prop_ident') {
                node[data] = []
                property = node[data]
            } else if (type == 'c_value_type') {
                property.push(data)
            }
        })

        start[0] = ++i
    }

    while (i < tokens.length) {
        if (new Tuple('parenthesis', '(').equals(tokens[i])) {
            var newdepth = depth + Math.min(tree.subtrees.length, 1)
            start[0] = i + 1

            t = exports.parse(tokens, callback, start, newdepth)
            t.parent = tree
            tree.subtrees.push(t)
            tree.current = 0

            i = start[0]
        } else if (new Tuple('parenthesis', ')').equals(tokens[i])) {
            start[0] = i
            callback(i / tokens.length)
            break
        }

        i++
    }

    return tree
}

exports.parseFile = function(filename, callback) {
    var input = fs.readFileSync(filename, { encoding: 'utf8' })
    var tokens = exports.tokenize(input)

    return exports.parse(tokens, callback)
}

exports.point2vertex = function(point) {
    if (point.length != 2) return new Tuple(-1, -1)

    point = point.toLowerCase()
    return new Tuple(alpha.indexOf(point[0]), alpha.indexOf(point[1]))
}

exports.vertex2point = function(tuple) {
    return tuple.unpack(function(x, y) {
        if (x < 0 || y < 0) return ''
        return alpha[x] + alpha[y]
    })
}

exports.compressed2list = function(compressed) {
    var colon = compressed.indexOf(':')
    if (colon < 0) return [exports.point2vertex(compressed)]

    var v1 = exports.point2vertex(compressed.slice(0, colon))
    var v2 = exports.point2vertex(compressed.slice(colon + 1))
    var list = []

    for (var i = v1[0]; i <= v2[0]; i++) {
        for (var j = v1[1]; j <= v2[1]; j++) {
            list.push(new Tuple(i, j))
        }
    }

    return list
}

exports.addBoard = function(tree, index, baseboard) {
    if (isNaN(index)) index = 0
    if (index >= tree.nodes.length) return tree

    var node = tree.nodes[index]
    var vertex = null
    var board = null

    if (!baseboard) {
        var prev = gametree.navigate(tree, index, -1)

        if (!prev[0]) {
            var size = 'SZ' in node ? node.SZ[0].toInt() : 19
            baseboard = new Board(size)
        } else {
            var prevNode = prev[0].nodes[prev[1]]

            if (!prevNode.board) exports.addBoard(prev[0], prev[1])
            baseboard = prevNode.board
        }
    }

    if ('B' in node) {
        vertex = exports.point2vertex(node.B[0])
        board = baseboard.makeMove(1, vertex)
    } else if ('W' in node) {
        vertex = exports.point2vertex(node.W[0])
        board = baseboard.makeMove(-1, vertex)
    } else {
        board = baseboard.makeMove(0)
    }

    var ids = ['AW', 'AE', 'AB']

    for (var i = 0; i < ids.length; i++) {
        if (!(ids[i] in node)) continue

        node[ids[i]].each(function(value) {
            if (value.indexOf(':') < 0) {
                // Single point
                board.arrangement[exports.point2vertex(value)] = i - 1
            } else {
                // Compressed point list
                exports.compressed2list(value).each(function(vertex) {
                    board.arrangement[vertex] = i - 1
                })
            }
        })
    }

    if (vertex != null) {
        board.overlays[vertex] = new Tuple('point', 0, '')
    }

    var ids = ['CR', 'MA', 'SQ', 'TR']
    var classes = ['circle', 'cross', 'square', 'triangle']

    for (var i = 0; i < ids.length; i++) {
        if (!(ids[i] in node)) continue

        node[ids[i]].each(function(value) {
            if (value.indexOf(':') < 0) {
                // Single point
                board.overlays[exports.point2vertex(value)] = new Tuple(classes[i], 0, '')
            } else {
                // Compressed point list
                exports.compressed2list(value).each(function(vertex) {
                    board.overlays[vertex] = new Tuple(classes[i], 0, '')
                })
            }
        })
    }

    if ('LB' in node) {
        node.LB.each(function(composed) {
            var sep = composed.indexOf(':')
            var point = composed.slice(0, sep)
            var label = composed.slice(sep + 1).replace(/\s+/, ' ')
            board.overlays[exports.point2vertex(point)] = new Tuple('label', 0, label)
        })
    }

    node.board = board

    if (index == tree.nodes.length - 1 && tree.subtrees.length > 0) {
        // Add variations

        tree.subtrees.each(function(subtree) {
            if (subtree.nodes.length == 0) return

            var v, sign

            if ('B' in subtree.nodes[0]) {
                v = sgf.point2vertex(subtree.nodes[0].B[0])
                sign = 1
            } else if ('W' in subtree.nodes[0]) {
                v = sgf.point2vertex(subtree.nodes[0].W[0])
                sign = -1
            } else {
                return
            }

            if (v in board.overlays)
                board.overlays[v] = board.overlays[v].unpack(function(a, b, c) {
                     return new Tuple(a, sign, c)
                })
            else board.overlays[v] = new Tuple('', sign, '')
        })
    }

    return tree
}

exports.tree2string = function(tree) {
    var output = ''

    tree.nodes.each(function(node) {
        output += ';'

        for (var id in node) {
            if (id.toUpperCase() != id) return
            output += id

            node[id].each(function(value) {
                output += '[' + exports.escapeString(value.toString()) + ']'
            })
        }

        output += '\n'
    })

    if (tree.current != null)
        output += '(' + exports.tree2string(tree.subtrees[tree.current]) + ')'

    for (var i = 0; i < tree.subtrees.length; i++) {
        if (i == tree.current) continue
        output += '(' + exports.tree2string(tree.subtrees[i]) + ')'
    }

    return output
}

exports.escapeString = function(input) {
    return input.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
}

exports.unescapeString = function(input) {
    return input.replace(/\\(\r\n|\n\r|\n|\r)/g, '').replace(/\\(.)/g, function(m, p) { return p })
}
