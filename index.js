'use strict';

var async = require('async');
var util = require('util');

var bitcore = require('bitcore-lib');
var bitcoreNode = require('bitcore-node');
var Service = bitcoreNode.Service;

// A prefix for our level db file hash keys to ensure there
// are no collisions with the bitcore namespace (0-255 is reserved by bitcore)
var PREFIX = 'NamingService';

var BYRD_CODE = '62797264'; // "byrd" in ascii hex, OP_RETURN outputs need this prefix in the data

var DEFAULT_FEE = 10000; // in satoshis, equal to 0.0001 BTC

function NamingService(options) {
  console.log('creating naming service');
  Service.call(this, options);
  this.node = options.node;
  this.data = {};
}
util.inherits(NamingService, Service);

NamingService.dependencies = ['bitcoind', 'db', 'web', 'address'];

NamingService.prototype.setupRoutes = function(app) {
  app.get('/name/:name', this.lookupBlueprintHashByName.bind(this));
  app.put('/name/:name', this.registerName.bind(this));
  app.get('/address/', this.fetchAddress.bind(this));
};

NamingService.prototype.blockHandler = function(block, add, callback) {
  console.log('got block');
  var self = this;
  var operations = [];
  var transactions = block.transactions;
  var height = block.__height;
  var registeredNamesInBlock = [];

  // Loop through every transaction in the block
  async.eachSeries(transactions, handleTransaction, function(err) {
    if (err) {
      return callback(err);
    }

    callback(null, operations);
  });

  function handleTransaction(transaction, callback) {
    console.log(' -handling transaction');
    var txid = transaction.id;
    var outputs = transaction.outputs;
    var outputScriptHashes = {};
    var outputLength = outputs.length;

    // Loop through every output in the transaction
    async.eachSeries(outputs, handleOutput, callback);
  }

  function handleOutput(output, callback) {
    console.log('  --handling output');
    var script = output.script;

    if(!script || !script.isDataOut()) {
      return callback();
    }

    var scriptData = script.getData().toString('hex');
    var dataPrefix = scriptData.slice(0,8);

    console.log('scriptData', scriptData);
    console.log('dattaPrefix', dataPrefix);

    if (dataPrefix !== BYRD_CODE) {
      return callback(); // this output did not have the byrd prefix in the data
    }

    var blueprintHash = scriptData.slice(8, 72); // the SHA256 hash of the blueprint
    var blueprintName = scriptData.slice(72);

    console.log('blueprintHash', blueprintHash);
    console.log('blueprintName', blueprintName);

    // Prepend a prefix to the key to prevent namespacing collisions
    var key = [PREFIX, blueprintName].join('-');
    var value = blueprintHash;


    if (!add) {
      var operation = {
        type: 'del',
        key: key,
        value: value
      };
      operations.push(operation);
      return callback();
    }

    if (registeredNamesInBlock.indexOf(blueprintName) !== -1) {
      return callback(); //this name was already registered in this block
    }

    self.node.services.db.store.get(key, {}, function(err, blueprintHash) {
      if (err && !err.notFound) {
        return callback(err);
      }

      if (blueprintHash) {
        return callback(); // this name has already been registered
      }

      console.log('storing with key ', key);
      var operation = {
        type: 'put',
        key: key,
        value: value
      };
      operations.push(operation);

      callback();
    });
  }
};


/*
transactionObj looks like

{ buffer: <Buffer 01 00 00 00 01 26 b7 80 ba 67 7b ff a5 17 2e d4 4a 61 af d4 f4 fc 85 79 52 25 9a 19 4a d4 f0 26 0b 89 73 92 4e 00 00 00 00 6b 48 30 45 02 21 00 ea 31 ... >,
  hash: '2f82a1e9e83fd0ada095edcd22bd1bc43d930e23e4bed1a41127ecd9889d06dc',
  mempool: true }

*/
NamingService.prototype.handleTransactionP2P = function(transactionObj) {
  var self = this;
  var transaction = new bitcore.Transaction().fromBuffer(transactionObj.buffer);

  var txid = transaction.id;
  var outputs = transaction.outputs;
  var outputScriptHashes = {};
  var outputLength = outputs.length;

  async.eachSeries(outputs, function(output, callback) {
    self.handleOutputP2P(output, callback);
  }, function(err) {
    if (err) {
      console.log(err);
    }
  });
};

NamingService.prototype.handleOutputP2P = function(output, callback) {
  var self = this;
  var script = output.script;

  if(!script || !script.isDataOut()) {
    return callback();
  }

  var scriptData = script.getData().toString('hex');
  var dataPrefix = scriptData.slice(0,8);

  console.log('scriptData', scriptData);
  console.log('dattaPrefix', dataPrefix);

  if (dataPrefix !== BYRD_CODE) {
    return callback(); // this output did not have the byrd prefix in the data
  }

  var blueprintHash = scriptData.slice(8, 72); // the SHA256 hash of the blueprint
  var blueprintName = scriptData.slice(72);

  console.log('blueprintHash', blueprintHash);
  console.log('blueprintName', blueprintName);

  // Prepend a prefix to the key to prevent namespacing collisions
  var key = [PREFIX, blueprintName].join('-');
  var value = blueprintHash;

  self.node.services.db.store.get(key, {}, function(err, blueprintHash) {
    if (err && !err.notFound) {
      return callback(err);
    }

    if (blueprintHash) {
      return callback(); // this name has already been registered
    }

    console.log('storing with key ', key);
    self.node.services.db.store.put(key, value, callback);
  });
};

// name in raw hex for now
NamingService.prototype._lookupBlueprintHashByName = function(name, callback) {
  var self = this;

  var key = [PREFIX, name].join('-');

  console.log('fetching with key ', key);
  this.node.services.db.store.get(key, {}, callback);
};

NamingService.prototype.lookupBlueprintHashByName = function(req, res, next) {
  var self = this;

  var name = req.params.name;

  if (!NamingService.isNameValid(name)) {
    return res.send(400, 'invalid name');
  }

  self._lookupBlueprintHashByName(name, function(err, blueprintHash) {
    if (err) {
      if (err.notFound) {
        return res.send(404);
      }
      return res.send(500, err.message);
    }

    res.send(blueprintHash);
  });
};

NamingService.prototype.registerName = function(req, res, next) {
  var self = this;

  var name = req.params.name;
  var blueprintHash = req.body.blueprintHash;

  if (!NamingService.isNameValid(name)) {
    return res.send(400, 'invalid name');
  }

  if (!NamingService.isBlueprintHashValid(blueprintHash)) {
    return res.send(400, 'invalid blueprintHash');
  }

  var key = [PREFIX, name].join('-');

  self.node.services.db.store.get(key, {}, function(err, hash) {
    if (err && !err.notFound) {
      return res.send(500, err);
    }

    if (hash) {
      return res.send(400, 'name already registered');
    }

    self._registerName(name, blueprintHash, function(err, txid) {
      if (err) {
        return res.send(500, err.message);
      }

      res.send(txid);
    });
  });
};

NamingService.prototype._registerName = function(name, blueprintHash, callback) {
  var self = this;

  self.createNamingTransaction(name, blueprintHash, callback);
};

NamingService.prototype.getRoutePrefix = function() {
  return 'namingService';
};

NamingService.prototype.createPrivateKey = function(callback) {
  var self = this;

  var privateKey = new bitcore.PrivateKey();

  // -------------------------------
  var publicKey = privateKey.toPublicKey();
  var address = new bitcore.Address(publicKey, bitcore.Networks.testnet);
  self.address = address;
  // -------------------------------

  var privateKeyWIF = privateKey.toWIF();

  var key = [PREFIX, 'privateKey'].join('-');

  self.node.services.db.store.put(key, privateKeyWIF, function(err) {
    if (err) {
      return callback(err);
    }

    callback(null, privateKeyWIF);
  });
};

NamingService.prototype.loadPrivateKey = function(callback) {
  var self = this;

  var key = [PREFIX, 'privateKey'].join('-');

  self.node.services.db.store.get(key, {}, function(err, privateKeyWIF) {
    if (err) {
      if (err.notFound) {
        return callback();
      }
      return callback(err);
    }

    callback(null, privateKeyWIF);
  });
};

//rawTransaction will have been serialized with Transaction.uncheckSerialize()
NamingService.prototype.sendTransaction = function(rawTransaction, callback) {
  var self = this;

  try {
    self.node.services.bitcoind.sendTransaction(rawTransaction);
  } catch (err) {
    return callback(err);
  }

  callback();
};

NamingService.prototype.createNamingTransaction = function(name, blueprintHash, callback) {
  var self = this;

  console.log('creating transaction with name: ', name, ' and blueprintHash: ', blueprintHash);

  self.getUTXO(DEFAULT_FEE, function(err, utxo) {
    if (err) {
      return callback(err);
    }

    var UnspentOutput = bitcore.Transaction.UnspentOutput;
    var bitcoreUtxo = UnspentOutput.fromObject(utxo);

    var opReturnData = BYRD_CODE + blueprintHash + name;
    var opReturnDataBuffer = new Buffer(opReturnData, 'hex');

    var transaction = new bitcore.Transaction();
    transaction
      .from(bitcoreUtxo)
      .fee(DEFAULT_FEE)
      .change(self.address)
      .addData(opReturnDataBuffer)// check the input type here, might need to be made into a buffer
      .sign(self.privateKey);

    var serializedTransaction = transaction.checkedSerialize();

    self.sendTransaction(serializedTransaction, function(err) {
      if (err) {
        return callback(err);
      }

      var txid = transaction.hash;
      console.log('sent transaction with txid: ', txid);

      callback(null, txid);
    });
  });
};



/*
utxos looks like this:

[
  {
    address: 'mgY65WSfEmsyYaYPQaXhmXMeBhwp4EcsQW',
    txid: '9d956c5d324a1c2b12133f3242deff264a9b9f61be701311373998681b8c1769',
    outputIndex: 1,
    height: 150,
    satoshis: 1000000000,
    script: '76a9140b2f0a0c31bfe0406b0ccc1381fdbe311946dadc88ac',
    confirmations: 3
  }
]
*/

//minamount is in satoshis
NamingService.prototype.getUTXO = function(minAmount, callback) {
  var self = this;
  var address = self.privateKey.toAddress(bitcore.Networks.testnet);
  var addressString = address.toString();
  var queryMempool = true;

  self.node.services.address.getUnspentOutputsForAddress(addressString, queryMempool, function(err, utxos) {
    if (err) {
      return callback(err);
    }

    var utxo = pickUTXO(utxos, minAmount);

    if (!utxo) {
      return callback(new Error('could not get a utxo'));
    }

    callback(null, utxo);
  });

  // pick the first utxo that has the minimum amount
  function pickUTXO(utxos, minAmount) {
    for (var i = 0; i < utxos.length; i++) {
      var utxo = utxos[i];
      if (utxo.satoshis >= minAmount) {
        return utxo;
      }
    }
  }
};

NamingService.isHex = function(input) {
  var validCharacters = '0123456789ABCDEF';
  var uppercaseInput = input.toUpperCase();
  for (var i = 0; i < uppercaseInput.length; i++) {
    var character = uppercaseInput[i];

    if (validCharacters.indexOf(character) === -1) {
      return false;
    }
  }
  return true;
};


NamingService.isNameValid = function(name) {
  if (!name) {
    return false;
  }

  if (!NamingService.isHex(name)) {
    return false;
  }

  if (name.length !== 88) { // 44 bytes for a name
    return false;
  }

  return true;
};

NamingService.isBlueprintHashValid = function(blueprintHash) {
  if (!blueprintHash) {
    return false;
  }

  if (!NamingService.isHex(blueprintHash)) {
    return false;
  }

  if (blueprintHash.length !== 64) { // 32 bytes for a blueprint hash (SHA256 hash)
    return false;
  }

  return true;
};

NamingService.prototype.getAddress = function() {
  return this.address;
};

NamingService.prototype.getAPIMethods = function() {
  return [];
};

NamingService.prototype.getPublishEvents = function() {
  return [];
};

NamingService.prototype.fetchAddress = function(req, res, next) {
  res.send(this.address.toString());
};

NamingService.prototype.start = function(callback) {
  var self = this;

  self.node.services.bitcoind.on('tx', function(tx) {
    self.handleTransactionP2P(tx);
  });

  self.loadPrivateKey(function(err, privateKeyWIF) {
    if (err) {
      return callback(err);
    }

    if (privateKeyWIF) {
      self.privateKey = bitcore.PrivateKey.fromWIF(privateKeyWIF);
      var publicKey = self.privateKey.toPublicKey();
      self.address = new bitcore.Address(publicKey, bitcore.Networks.testnet);
      return callback();
    }

    self.createPrivateKey(function(err, privateKeyWIF) {
      if (err) {
        return callback(err);
      }

      self.privateKey = bitcore.PrivateKey.fromWIF(privateKeyWIF);
      var publicKey = self.privateKey.toPublicKey();
      self.address = new bitcore.Address(publicKey, bitcore.Networks.testnet);

      return callback();
    });
  });
};

NamingService.prototype.stop = function(callback) {
  setImmediate(callback);
};

module.exports = NamingService;
