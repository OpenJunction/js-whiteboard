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
					this.MSG_HELLO = 8;

					this.EVT_CHANGE = "change";
					this.EVT_SYNC = "sync";

					this.NO_SEQ_NUM = -1;

					this.uuid = randomUUID().toString();
					this.propName = propName;
					this.propReplicaName = propReplicaName || propName + "-replica" + randomUUID();

					this.state = state;
					this.cleanState = state.copy();

					this.sequenceNum = this.NO_SEQ_NUM;
					this.mode = this.MODE_NORM;
					this.syncId = "";
					this.waitingForIHaveState = false;
					this.opsSYNC = [];

					this.pendingLocals = [];
					this.changeListeners = [];
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
					this.actor.junction.logInfo("opsSync: " + this.opsSYNC);
					this.actor.junction.logInfo("sequenceNum: " + this.sequenceNum);
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
						jsonMsg.senderActor = msgHeader.from;
						this.handleMessage(jsonMsg);
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
					var i;
					var msg;
					var changed = false;
					if(opMsg.expectedSeqNum > this.sequenceNum + 1){
						enterSYNCMode(opMsg.expectedSeqNum);
						return;
					}
					this.sequenceNum = opMsg.seqNum;
					this.pendingLocals = [];
					if(isSelfMsg(opMsg)){
						assert(this.opMsg.uuid == this.pendingLocals[0].uuid);
						this.cleanState.applyOperation(opMsg);
						this.pendingLocals.splice(0,1);
					}
					else{
						if(this.pendingLocals.length > 0){
							this.cleanState.applyOperation(opMsg);
							this.state = this.cleanState.copy();
							for(i = 0; i < this.pendingLocals.length; i++){
								msg = this.pendingLocals[i];
								this.state.applyOperation(msg.op);
							}
						}
						else{
							assert(this.state.hash() == this.cleanState.hash());
							this.cleanState.applyOperation(opMsg);
							this.state.applyOperation(opMsg);
						}
						changed = true;
					}

					if(changed){
						dispatchChangeNotification(this.EVT_CHANGE, null);
					}

					this.logState("Got op off wire, finished processing: " + opMsg);
				},



				
				/**
				 * Helper for sending off the serialized state to a peer.
				 */
				handleStateSyncRequest: function(m){
					var sync = {
						type: this.MSG_STATE_SYNC,
						state: this.cleanState.stringify(),
						syncId: m.syncId,
						opSeqNum: this.sequenceNum,
						seqNumCounter: this.seqNumCounter,
						lastOrderAckUUID: this.lastOrderAckUUID,
						lastOpUUID: this.lastOpUUID
					};
					this.sendMessageToPropReplica(m.senderActor, sync);
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
					clearArray(this.opsSYNC);
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
							this.handleReceivedOp(msg.op);
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
									this.logInfo("Handling SEND_ME_STATE request.");
									this.handleStateSyncRequest(msg);
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
								if(msg.expectedSeqNum < this.sequenceNum){
									this.sendMessageToPropReplica(
										fromActor,
										{type: this.MSG_PLZ_CATCHUP, 
										 seqNum: this.sequenceNum});
								}
							}
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

									this.cleanState = this.reifyState(msg.state);
									this.sequenceNum = msg.opSeqNum;

									this.logInfo("Installed state.");
									this.logInfo("sequenceNum:" + this.sequenceNum);
									this.logInfo("Now applying buffered things....");

									// We may have applied some predictions locally.
									// Just forget all these predictions (we're wiping our
									// local state completely. 
									clearArray(this.pendingLocals);

									// Apply any ops that we recieved while syncing,
									// ignoring those that are incorporated into sync state.
									for(var j = 0; j < this.opsSYNC.length; j++){
										var m = this.opsSYNC[j];
										if(m.seqNum > this.sequenceNum){
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
						this.state.applyOperation(operation);
						this.dispatchChangeNotification(this.EVT_CHANGE, null);
						var msg = {
							type: this.MSG_STATE_OPERATION, 
							op: operation, 
							predicted: true,
							expectedSeqNum: this.sequenceNum + 1
						};
						this.pendingLocals.push(msg);
						this.logState("Requesting order ack: " + ack);
						this.sendMessageToProp(msg);
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
					this.sendMessageToProp({ type:this.MSG_HELLO, expectedSeqNum: this.sequenceNum + 1});
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