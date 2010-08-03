var JunctionProps = new (
	function(){

		this.scr = function(){
			throw new Error("ERROR: Subclass responsibility!");
		};

		this.nyi = function(){
			throw new Error("ERROR: Not yet implemented!");
		};

		this.Prop = JX.JunctionExtra.extend(
			{
				init: function(propName, state, propReplicaName){
					this._super();

					this.MODE_NORM = 1;
					this.MODE_SYNC = 2;

					this.MSG_STATE_OPERATION = 1;
					this.MSG_STATE_SYNC = 2;
					this.MSG_WHO_HAS_STATE = 3;
					this.MSG_I_HAVE_STATE = 4;
					this.MSG_SEND_ME_STATE = 5;
					this.MSG_PLZ_CATCHUP = 6;
					this.MSG_OP_ORDER_ACK = 7;
					this.MSG_HELLO = 8;

					this.EVT_CHANGE = "change";
					this.EVT_SYNC = "sync";

					this.NO_SEQ_NUM = -1;

					this.uuid = randomUUID().toString();
					this.propName = propName;
					this.propReplicaName = propReplicaName || propName + "-replica" + randomUUID();

					this.state = state;

					this.seqNumCounter = 0;
					this.sequenceNum = 0;
					this.lastOrderAckUUID = "";
					this.lastOpUUID = "";
					this.mode = this.MODE_NORM;
					this.staleness = 0;
					this.syncId = "";
					this.waitingForIHaveState = false;

					this.orderAckSYNC = [];
					this.opsSYNC = [];

					this.stateSyncRequests = [];

					this.pendingLocals = [];
					this.sequentialOpsBuffer = [];
					this.changeListeners = [];

				},


				getStaleness: function(){
					return this.staleness;
				},

				getSequenceNum: function(){
					return this.sequenceNum;
				},

				getState: function(){
					return this.state;
				},

				stateToString: function(){
					return this.state.toString();
				},

				getPropName: function(){
					return this.propName;
				},

				logInfo: function(s){
					this.actor.junction.logInfo("prop@" + this.propReplicaName + ": " + s);
				},

				logErr: function(s){
					this.actor.junction.logError("prop@" + this.propReplicaName + ": " + s);
				},

				logState: function(s){
					this.actor.junction.logInfo("\n");
					this.logInfo(s);
					this.actor.junction.logInfo("pendingLocals: " + this.pendingLocals);
					this.actor.junction.logInfo("orderAckSYNC: " + this.orderAckSYNC);
					this.actor.junction.logInfo("opsSync: " + this.opsSYNC);
					this.actor.junction.logInfo("sequentialOpsBuffer: " + this.sequentialOpsBuffer);
					this.actor.junction.logInfo("sequenceNum: " + this.sequenceNum);
					this.actor.junction.logInfo("seqNumCounter: " + this.seqNumCounter);
					this.actor.junction.logInfo("\n");
					this.actor.junction.logInfo("");
				},

				/*abstract*/ destringifyState: function(s){ scr(); },
				/*abstract*/ destringifyOperation: function(s){ scr(); },

				addChangeListener: function(listener){
					this.changeListeners.push(listener);
				},

				/**
				 * Dispatch a change event to all listeners. Each listener will
				 * of type evtType will be applied to the argument o (an arbitrary
				 *  data value).
				 */
				dispatchChangeNotification: function(evtType, o){
					for(var i = 0; i < this.changeListeners.length; i++){
						var l = this.changeListeners[i];
						if(l.type == evtType){
							l.onChange(o);
						}						 
					}
				},

				/**
				 * Returns true if the normal event handling should proceed;
				 * Return false to stop cascading.
				 */
				beforeOnMessageReceived: function(msgHeader, jsonMsg) {
					if(jsonMsg.propTarget == this.propName){
						var msg = this.propMsgFromJSONObject(msgHeader, jsonMsg);
						this.handleMessage(msg);
						return false;
					}
					else{
						return true; 
					}
				},


				/**
				 * What to do with a newly arrived operation? Depends on mode of 
				 * operation.
				 */
				handleReceivedOp: function(opMsg){
					this.lastOpUUID = opMsg.uuid;
					// Sort it into the buffer.
					var buf = this.sequentialOpsBuffer;
					buf.push(opMsg);
					var len = buf.length;
					for(var i = 0; i < len; i++){
						var m = buf[i];
						if(opMsg.seqNum < m.seqNum){
							var tmp = buf.pop();
							buf.splice(i, 0, tmp);
							break;
						}
					}
					// Process any messages that are ready..
					this.processIncomingOpsSequentially();
					
					// Send out any pending broadcasts of predicted operations..
					this.processDeferredBroadcasts();

					// Check if state is calm, to process any pending state sync requests..
					this.processStateSyncRequests();
					this.logState("Got op off wire, finished processing: " + opMsg);
				},


				/**
				 * Process as many state ops as possible.
				 */
				processIncomingOpsSequentially: function(){
					// Recall that the sequence is always sorted
					// in ascending order of sequence number.
					var buf = this.sequentialOpsBuffer;
					var i;
					var len = buf.length;

					// Proposal:
					// If we're stuck waiting for a particular message,
					// forget it after some threshold.
					// Note, this decision MUST be the same at all replicas!
					if(len > 10){
						this.logErr("sequentialOpsBuffer buffer too long! All replicas to next message!");
						this.sequenceNum = buf[0].seqNum - 1;
					}

					for(i = 0; i < len; i++){
						var m = buf[i];
						if(m.seqNum < (this.sequenceNum + 1)){
							// We want to discard messages that are too early.
							// Decrement the sequence number counter, since we're not using that sequence num..
							this.seqNumCounter -= 1;
							this.logErr("Decrementing seqNumCounter, and ignoring: " + m);
						}
						else if(m.seqNum == (this.sequenceNum + 1)){
							this.sequenceNum = m.seqNum;
							this.applyOperation(m, true, false);
							this.logInfo("Sequentially processed: " + m.seqNum);
							// There might be multiple to handle..
						}
						else if(m.seqNum > (this.sequenceNum + 1)){
							break;
						}
					}
					buf.splice(0,i);
				},


				
				/**
				 * Wait for a moment of calm to send out state synchronization messages.
				 * Otherwise we would have to serialize all these buffers and send as part
				 * of the sync.
				 *
				 * Question: Is it realistic to expect these all to be empty at some times?
				 */
				processStateSyncRequests: function(){
					if(this.sequentialOpsBuffer.length == 0 && 
					   this.pendingLocals.length == 0){
						for(var i = 0; i < this.stateSyncRequests.length; i++){
							var m = this.stateSyncRequests[i];
							var sync = {
								type: this.MSG_STATE_SYNC,
								state: this.state.stringify(),
								syncId: m.syncId,
								opSeqNum: this.sequenceNum,
								seqNumCounter: this.seqNumCounter,
								lastOrderAckUUID: this.lastOrderAckUUID,
								lastOpUUID: this.lastOpUUID
							};
							this.sendMessageToPropReplica(m.senderActor, sync);
						}
						clearArray(this.stateSyncRequests);
					}
				},


				
				/**
				 * The order ack tells us the sequence number for the 
				 * corresponding message. Set the sequence number.
				 *
				 * deferredSend will broadcast the message once all msgs
				 * with smaller sequence numbers have been handled.
				 */
				handleOrderAck: function(msg){
					// Is this a safe assumption?
					if(msg.seqNum > this.sequenceNum){
						this.logState("Ignoring order ack that's too new:" + msg);
						this.logInfo("msg sequenceNum is newer: " + msg.seqNum);
						if(this.mode == this.MODE_NORM && !this.isSelfMsg(msg)){
							this.enterSYNCMode(msg.seqNum);
							this.orderAckSYNC.push(msg);
						}
					}
					else{
						this.seqNumCounter += 1;
						this.lastOrderAckUUID = msg.uuid;
						if(!this.isSelfMsg(msg)){
							this.logState("Acknowledging peer's order ack: " + msg);
						}
						else{
							
							// When we get back the authoritative order for 
							// a message...
							var found = false;

							for(var i = 0; i < this.pendingLocals.length; i++){
								var m = this.pendingLocals[i];
								if(m.uuid == msg.uuid){
									m.seqNum = this.seqNumCounter;
									this.logState("Ordered local prediction: " + m);
									found = true;
									break;
								}
							}
							
							if(!found){
								this.logErr("Ack of local op could not find pending op!!");
							}
						}
					}
					this.processDeferredBroadcasts();
					this.processStateSyncRequests();
				},

				/**
				 * Broadcasts of predicted ops are deferred until the local 
				 * sequence number indicates that all messages with lesser
				 * sequence numbers have been processed.
				 */
				processDeferredBroadcasts: function(){
					// Note. Messages should be sorted in ascending order of sequenceNumber
					var unsent = [];
					for(var i = 0; i < this.pendingLocals.length; i++){
						var m = this.pendingLocals[i];
						if(m.seqNum <= (this.sequenceNum + 1) && (m.seqNum != this.NO_SEQ_NUM)){

							// TODO: nasty
							m.op = m.op.stringify();

							this.sendMessageToProp(m);
							this.logInfo("Broadcast deferred op: " + m.seqNum);
						}
						else{
							unsent.push(m);
						}
					}
					this.pendingLocals = unsent;
				},


				/**
				 * See 'Copies convergence in a distributed real-time collaborative environment' 2000 
				 *  Vidot, Cart, Ferrie, Suleiman
				 *
				 */
				applyOperation: function(msg, notify, localPrediction){
					var op = msg.op;
					if(localPrediction){
						// apply predicted operation immediately
						this.state = this.state.applyOperation(op);
						if(notify){
							this.dispatchChangeNotification(this.EVT_CHANGE, op);
						}
					}
					else if(!this.isSelfMsg(msg)){ // Broadcasts of our own local ops are ignored.
						try{
							var remoteOpT = msg.op;
							for(var i = 0; i < this.pendingLocals.length; i++){
								var local = this.pendingLocals[i];
								var localOp = local.op;
								var localOpT = this.transposeForward(remoteOpT, localOp);
								this.pendingLocals[i] = local.newWithOp(localOpT);
								remoteOpT = this.transposeForward(localOp, remoteOpT);
							}
							this.state = this.state.applyOperation(remoteOpT);
						}
						catch(e){
							this.logErr(" --- STATE IS CORRUPT! ---  " + e.message);
						}

						if(notify){
							this.dispatchChangeNotification(this.EVT_CHANGE, msg.op);
						}
					}

				},

				/**
				 * Assume o1 and o2 operate on the same state s.
				 * 
				 * Intent Preservation:
				 * transposeForward(o1,o2) is a new operation, defined on the state resulting from the execution of o1, 
				 * and realizing the same intention as op2.
				 * 
				 * Convergence:
				 * It must hold that o1*transposeForward(o1,o2) = o2*transposeForward(o2,o1).
				 *
				 * (where oi*oj denotes the execution of oi followed by the execution of oj)
				 * 
				 */
				transposeForward: function(o1, o2){
					return o2;
				},

				exitSYNCMode: function(){
					this.logInfo("Exiting SYNC mode");
					this.mode = this.MODE_NORM;
					this.syncId = "";
					this.waitingForIHaveState = false;
				},

				enterSYNCMode: function(desiredSeqNumber){
					this.logInfo("Entering SYNC mode.");
					this.mode = this.MODE_SYNC;
					this.syncId = randomUUID();
					this.sequenceNum = -1;
					this.seqNumCounter = -1;
					clearArray(this.orderAckSYNC);
					clearArray(this.opsSYNC);
					clearArray(this.sequentialOpsBuffer);
					this.sendMessageToProp({ type: this.MSG_WHO_HAS_STATE, 
											 desiredSeqNumber: desiredSeqNumber, 
											 syncId: this.syncId});
					this.waitingForIHaveState = true;
				},

				isSelfMsg: function(msg){
					return msg.senderReplicaUUID == this.uuid;
				},

				handleMessage: function(rawMsg){
					var msgType = rawMsg.type;
					var fromActor = rawMsg.senderActor;
					switch(this.mode){
					case this.MODE_NORM:
						switch(msgType){
						case this.MSG_STATE_OPERATION: {
							var msg = rawMsg;
							msg.op = this.destringifyOperation(msg.op);
							this.handleReceivedOp(msg);
							break;
						}
						case this.MSG_WHO_HAS_STATE:{
							var msg = rawMsg;
							if(!this.isSelfMsg(msg)){
								// Can we fill the gap for this peer?
								if(this.sequenceNum >= msg.desiredSeqNumber){
									this.logInfo("Got WHO_HAS_STATE. Sending I_HAVE_STATE.");
									this.sendMessageToPropReplica(
										fromActor, 
										{ type: this.MSG_I_HAVE_STATE,
										  seqNum: this.sequenceNum,
										  syncId: msg.syncId });
								}
								else{
									this.logInfo("Oops! got state request for state i don't have!");
								}
							}
							break;
						}
						case this.MSG_SEND_ME_STATE: {
							var msg = rawMsg;
							if(!this.isSelfMsg(msg)){
								// Can we fill the gap for this peer?
								if(this.sequenceNum >= msg.desiredSeqNumber){
									this.logInfo("Enqueing SEND_ME_STATE request.");
									this.stateSyncRequests.push(msg);
									this.processStateSyncRequests();
								}
							}
							break;
						}
						case this.MSG_PLZ_CATCHUP:{
							var msg = rawMsg;
							if(!this.isSelfMsg(msg)){
								// Some peer is trying to tell us we are stale.
								// Do we believe them?
								this.logInfo("Got PlzCatchup : " + msg);
								if(msg.seqNum > this.sequenceNum) {
									this.enterSYNCMode(msg.seqNum);
								}
							}
							break;
						}
						case this.MSG_HELLO:{
							var msg = rawMsg;
							if(!this.isSelfMsg(msg)){
								if(msg.seqNum < this.sequenceNum) {
									this.sendMessageToPropReplica(
										fromActor,
										{type: this.MSG_PLZ_CATCHUP, 
										 seqNum: this.sequenceNum});
								}
							}
							break;
						}
						case this.MSG_OP_ORDER_ACK:{
							var msg = rawMsg;
							this.handleOrderAck(msg);
							break;
						}
						case this.MSG_STATE_SYNC:
							break;
						case this.MSG_I_HAVE_STATE:
							break;
						default:
							this.logErr("NORM mode: Unrecognized message, "  + rawMsg);
						}
						break;
					case this.MODE_SYNC:
						switch(msgType){
						case this.MSG_STATE_OPERATION:{
							var msg = rawMsg;
							if(!this.isSelfMsg(msg)){
								this.opsSYNC.push(msg);
								this.logInfo("SYNC mode: buffering op..");
							}
							else{
								this.logInfo("SYNC mode: ignoring this op..");
							}
							break;
						}
						case this.MSG_I_HAVE_STATE:{
							var msg = rawMsg;
							if(!this.isSelfMsg(msg) && this.waitingForIHaveState){
								if(msg.syncId == this.syncId && msg.seqNum > this.sequenceNum){
									this.waitingForIHaveState = false;
									this.logInfo("Got I_HAVE_STATE. Sending SEND_ME_STATE.");
									this.sendMessageToPropReplica(
										fromActor, 
										{type: this.MSG_SEND_ME_STATE, 
										 desiredSeqNumber: msg.seqNum, 
										 syncId: msg.syncId
										});
								}
							}
							break;
						}
						case this.MSG_OP_ORDER_ACK:{
							var msg = rawMsg;
							if(!this.isSelfMsg(msg)){
								this.orderAckSYNC.push(msg);
								this.logInfo("SYNC mode: buffering order ack..");
							}
							else{
								this.logInfo("SYNC mode: ignoring this order ack..");
							}
							break;
						}
						case this.MSG_STATE_SYNC:{
							var msg = rawMsg;
							if(!this.isSelfMsg(msg)){
								// First check that this sync message corresponds to this
								// instance of SYNC mode. This is critical for assumptions
								// we make about the contents of incomingBuffer...
								if(msg.syncId != this.syncId){
									this.logInfo("Bogus SYNC nonce! ignoring StateSyncMsg");
								}
								else{
									this.logInfo("Got StateSyncMsg:" + msg);

									this.state = this.destringifyState(msg.state);
									this.sequenceNum = msg.opSeqNum;
									this.seqNumCounter = msg.seqNumCounter;
									this.lastOrderAckUUID = msg.lastOrderAckUUID;
									this.lastOpUUID = msg.lastOpUUID;

									this.logInfo("Installed state.");
									this.logInfo("sequenceNum:" + this.sequenceNum);
									this.logInfo("seqNumCounter:" + this.seqNumCounter);
									this.logInfo("Now applying buffered things....");

									// We may have applied some predictions locally.
									// Just forget all these predictions (we're wiping our
									// local state completely. Any straggler ACKS originating
									// from this peer will have to be ignored..
									clearArray(this.pendingLocals);

									// Apply any ordering acknowledgements that 
									// we recieved while syncing. Ignore those that are
									// already incorporated into sync state.
									var apply = false;
									for(var i = 0; i < this.orderAckSYNC.length; i++){
										var m = this.orderAckSYNC[i];
										if(!apply && m.uuid == this.lastOrderAckUUID){
											apply = true;
											continue;
										}
										else if(apply){
											this.handleOrderAck(m);
										}
									}
									clearArray(this.orderAckSYNC);

									// Apply any ops that we recieved while syncing,
									// ignoring those that are incorporated into sync state.
									apply = false;
									for(var j = 0; j < this.opsSYNC.length; j++){
										var m = this.opsSYNC[j];
										if(!apply && m.uuid == this.lastOpUUID){
											apply = true;
											continue;
										}
										else if(apply){
											this.handleReceivedOp(m);
										}
									}
									clearArray(this.opsSYNC);

									this.exitSYNCMode();

									this.logState("Finished syncing.");

									this.dispatchChangeNotification(this.EVT_SYNC, null);
								}
							}
							break;
						}
						}
					}
				},


				/**
				 * Add an operation to the state managed by this Prop
				 */
				addOperation: function(operation){
					if(this.mode == this.MODE_NORM){
						this.logInfo("Adding predicted operation.");
						var msg = {
							type: this.MSG_STATE_OPERATION, 
							op: operation, 
							predicted: true
						};
						this.applyOperation(msg, true, true);
						this.pendingLocals.push(msg);
						var ack = {type: this.MSG_OP_ORDER_ACK,
								   msgUUID: msg.uuid, 
								   predicted: true, 
								   seqNum: this.sequenceNum
								  };
						this.logState("Requesting order ack: " + ack);
						this.sendMessageToProp(ack);
					}
				},


				/**
				 * Send a message to all prop-replicas in this prop
				 */
				sendMessageToProp: function(m){
					m.propTarget = this.propName;
					m.senderReplicaUUID = this.uuid;
					this.actor.sendMessageToSession(m);
				},


				/**
				 * Send a message to the prop-replica hosted at the given actorId.
				 */
				sendMessageToPropReplica: function(actorId, m){
					m.propTarget = this.propName;
					m.senderReplicaUUID = this.uuid;
					this.actor.sendMessageToActor(actorId, m);
				},
				
				afterActivityJoin: function() {
					this.sendMessageToProp({ type:this.MSG_HELLO, seqNum: this.sequenceNum });
				},

				propMsgFromJSONObject: function(header, msg, prop){
					msg.senderActor = header.from;
					return msg;
				}

			});



		this.ListProp = this.Prop.extend(
			{

				init: function(propName, builder){
					this._super(propName, new this.ListState(), null);
					this.builder = builder;
				},

				/**
				 * Assume o1 and o2 operate on the same state s.
				 * 
				 * Intent Preservation:
				 * transposeForward(o1,o2) is a new operation, defined on the state resulting from the execution of o1, 
				 * and realizing the same intention as op2.
				 * 
				 * Convergence:
				 * It must hold that o1*transposeForward(o1,o2) = o2*transposeForward(o2,o1).
				 *
				 * (where oi*oj denotes the execution of oi followed by the execution of oj)
				 * 
				 */
				transposeForward: function(o1, o2){
					if(s1.item.equals(s2.item)){
						if(s1 instanceof this.AddOp && s2 instanceof this.AddOp){
							// No problem, Set semantics take care of everything.
							return s1;
						}
						else if(s1 instanceof this.DeleteOp && s2 instanceof this.DeleteOp){
							// No problem, just delete it..
							return s1;
						}
						else if(s1 instanceof this.AddOp && s2 instanceof this.DeleteOp){
							// Delete takes precedence..
							return s2;
						}
						else if(s1 instanceof this.DeleteOp && s2 instanceof this.AddOp){
							// Delete takes precedence..
							return s1;
						}
						else{
							throw "UnexpectedOpPairException";
						}
					}
					else{
						// Different items. No conflict possible. Choose either op.
						return s2;
					}
				},

				add: function(item){
					this.addOperation(new this.AddOp(item));
				},

				delete: function(item){
					this.addOperation(new this.DeleteOp(item));
				},

				eachItem: function(iter){
					this.state.eachItem(iter);
				},

				destringifyState: function(s){
					try{	   
						var obj = JSON.parse(s);
						var type = obj.type;
						if(type == "ListState"){
							var a = obj.items;
							var items = [];
							for(var i = 0; i < a.length; i++){
								var item = this.builder.destringify(a[i]);
								items.push(item);
							}
							return new this.ListState(items);
						}
						else {
							return new this.ListState([]);
						}
					}
					catch(e){
						return new this.ListState([]);
					}
				},

				destringifyOperation: function(s){
					try{
						var obj = JSON.parse(s);
						var type = obj.type;
						if(type == "addOp"){
							var item = this.builder.destringify(obj.item);
							return new this.AddOp(item);
						}
						else if(type == "deleteOp"){
							var item = this.builder.destringify(obj.item);
							return new this.DeleteOp(item);
						}
						else{
							return new this.NullOp();
						}
					}
					catch(e){
						return null;
					}
				},

				AddOp: Class.extend(
					{
						init:function(item){
							this.item = item;
						},

						applyTo: function(s){
							var newS = s.copy();
							newS.add(this.item);
							return newS;
						},

						stringify: function(){
							var obj = {
								type: "addOp",
								item: this.item.stringify()
							};
							return JSON.stringify(obj);
						}
					}),

				DeleteOp: Class.extend(
					{
						init:function(item){
							this.item = item;
						},

						applyTo: function(s){
							var newS = s.copy();
							newS.delete(item);
							return newS;
						},

						stringify: function(){
							var obj = {
								type: "deleteOp",
								item: item.stringify()
							};
							return JSON.stringify(obj);
						}
					}),
				


				ListState: Class.extend(
					{
						
						init: function(_inItems){
							var inItems = _inItems || [];
							this.items = [];
							for(var i = 0; i < inItems.length; i++){
								this.items.push(inItems[i].copy());
							}
						},

						applyOperation: function(operation){
							return operation.applyTo(this);
						},

						eachItem: function(iterator){
							for(var i = 0; i < this.items.length; i++){
								iterator(this.items[i]);
							}
						},

						stringify: function(){
							var obj = {};
							var a = [];
							this.eachItem(function(ea){
											  a.push(ea.stringify()); 
										  });
							obj.type = "ListState";
							obj.items = a;
							return JSON.stringify(obj);
						},

						copy: function(){
							return new JunctionProps.ListProp.prototype.ListState(this.items);
						},

						add: function(item){
							this.items.push(item);
						},

						delete: function(item){
							this.items.remove(item);
						}

					})

			});




	})(); // end JunctionProps