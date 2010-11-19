var DrawingBoard =
	new (function(){
			 this.Board = Class.extend(
				 {
					 init: function(canvas, name, model){
						 var self = this;
						 this.granularity = 3;
						 this.isIPhone = (new RegExp( "iPhone", "i" )).test(
							 window.navigator.userAgent
						 );
						 this.name = name;

						 this.currentPoints = [];
						 this.color = "#ff0000";
						 this.strokeWidth = 5;

						 this.moveCounter = 0;

						 this.canvas = canvas;
						 // Get the 2D canvas context.
						 this.context = canvas.getContext('2d');
						 if (!this.context) {
							 alert('Error: failed to getContext!');
							 return;
						 }
						 this.context.strokeStyle = this.color;
						 this.context.lineWidth   = this.strokeWidth;
						 this.context.lineCap   = "round";

						 this.model = model;				
						 this.model.addChangeListener({ type: "change",
														onChange: function(o){
															self.modelChanged();
														}});
						 this.model.addChangeListener({ type: "sync",
														onChange: function(o){
															self.modelChanged();
														}});

						 $(this.canvas).bind(
							 (this.isIPhone ? "touchstart" : "mousedown"),
							 function(event){
								 self.penDown(event);
								 // Return FALSE to prevent the default behavior
								 // of the touch event (scroll / gesture) since
								 // we only want this to perform a drawing
								 // operation on the canvas.
								 return false;
							 }
						 );

						 this.canvas.style.display = "block";

					 },

					 setColor: function(hexStr){
						 this.color = "#" + hexStr;
						 this.context.strokeStyle = this.color;
					 },

					 setStrokeWidth: function(width){
						 this.strokeWidth = width;
						 this.context.lineWidth = this.strokeWidth;
					 },

					 modelChanged: function(){
						 var self = this;
						 this.context.clearRect(0,0, $(this.canvas).width(), $(this.canvas).height());
						 this.model.eachItem(function(s){
												 self.drawStroke(s);
											 });
					 },

					 drawStroke: function(stroke){
						 // In case user's stroke is interrupted,
						 // save away the current state..
						 var curX = 0;
						 var curY = 0;

						 if(this.currentPoints.length >= 2){
							 curX = this.currentPoints[this.currentPoints.length - 1];
							 curY = this.currentPoints[this.currentPoints.length - 2];
						 }

						 var points = stroke.points;
						 this.context.strokeStyle = stroke.color;
						 this.context.lineWidth = stroke.width;

						 var x1, y1, x2, y2;
						 if(points.length >= 4){
							 this.context.beginPath();
							 x1 = points[0];
							 y1 = points[1];
							 this.context.moveTo(x1,y1);
							 for(var i = 2; i < points.length; i += 2){
								 x2 = points[i];
								 y2 = points[i + 1];
								 this.context.lineTo(x2,y2);
								 this.context.moveTo(x2,y2);
							 }
							 this.context.stroke();
						 }


						 // Restore saved state
						 this.context.strokeStyle = this.color;
						 this.context.lineWidth   = this.strokeWidth;
						 this.context.moveTo(curX, curY);
					 },

					 penDown: function (rawEv) {
						 var self = this;
						 var ev = this.getPlatformEvent(rawEv);
						 this.context.beginPath();
						 this.context.moveTo(ev.localX, ev.localY);
						 this.currentPoints = [ev.localX, ev.localY];
						 this.moveCounter = 0;
						 $(this.canvas).bind((this.isIPhone ? "touchmove" : "mousemove"), function(ev){ self.penMove(ev);});
						 $(this.canvas).bind((this.isIPhone ? "touchend" : "mouseup"), function(ev){ self.penUp(ev);});
					 },

					 penMove: function (rawEv) {
						 var ev = this.getPlatformEvent(rawEv);
						 if((this.moveCounter % this.granularity) == 0){
							 this.context.lineTo(ev.localX, ev.localY);
							 this.context.stroke();
							 this.currentPoints.push(ev.localX);
							 this.currentPoints.push(ev.localY);
						 }
						 this.moveCounter++;
					 },


					 penUp: function (rawEv) {
						 this.model.add(this.model.newStroke(this.color, this.strokeWidth, this.currentPoints));
						 $(this.canvas).unbind((this.isIPhone ? "touchmove" : "mousemove"));
						 $(this.canvas).unbind((this.isIPhone ? "touchend" : "mouseup"));
					 },


					 getPlatformEvent: function(rawEv){
						 // Check to see if we are in the iPhone. If so,
						 // grab the native touch event. By its nature,
						 // the iPhone tracks multiple touch points; but,
						 // to keep this demo simple, just grab the first
						 // available touch event.

						 var ev = this.isIPhone ? window.event.targetTouches[0] : rawEv;
						 ev.localX = ev.pageX - ev.target.offsetLeft;
						 ev.localY = ev.pageY - ev.target.offsetTop;

						 return ev;
					 }

				 });


			 this.init = function(canvas, name){
				 var board;

				 canvas.style.display = "none";
				 
				 var isIPhone = (new RegExp( "iPhone", "i" )).test(
					 window.navigator.userAgent
				 );

				 // Init the color picker
				 if(isIPhone){
					 $('#colorSelector').hide();
				 }
				 else{
					 $('#colorSelector').ColorPicker(
						 {
							 color: '#0000ff',
							 onShow: function (colpkr) {
								 $(colpkr).fadeIn(200);
								 return false;
							 },
							 onHide: function (colpkr) {
								 $(colpkr).fadeOut(100);
								 return false;
							 },
							 onChange: function (hsb, hex, rgb) {
								 $('#colorSelector div').css('backgroundColor', '#' + hex);
								 board.setColor(hex);
							 }
						 });
				 }


				 // Init the brush size selectors
				 $('#brush1').click(function(){ board.setStrokeWidth(5);});
				 $('#brush2').click(function(){ board.setStrokeWidth(10);});
				 $('#brush3').click(function(){ board.setStrokeWidth(15);});
				 $('#brush4').click(function(){ board.setStrokeWidth(20);});

				 // Init the color pallette selectors
				 $('#color1').click(function(){ board.setColor("000000");});
				 $('#color2').click(function(){ board.setColor("0000ff");});
				 $('#color3').click(function(){ board.setColor("ff0000");});
				 $('#color4').click(function(){ board.setColor("00ff00");});
				 $('#color5').click(function(){ board.setColor("ffffff");});


				 // Init the whiteboard

				 var model = new BoardProp("whiteboard_model");

				 var boardClient = {
					 roles: ["participant"],
					 onMessageReceived: function(msg, header) {
						 if(msg.text){
							 alert(msg.text);
						 }
						 else{
							 alert("Unexpected message: " + JSON.stringify(msg));
						 }
					 },
					 onActivityJoin: function() {
						 board = new DrawingBoard.Board(canvas, name, model);
					 },
					 initialExtras: [model]
				 };


				 var ascript = {
					 host: "sb.openjunction.org",
					 ad: "edu.stanford.junction.whiteboard",
					 friendlyName: "White Board",
					 roles: { "buddy": {"platforms" : { /* platform definitions */ }}},
					 sessionID: "whiteboard"
				 };

				 var jx = JX.newJunction(ascript, boardClient);

				 $("#permalink").attr('href', jx.getInvitationForWeb("buddy"));
			 };


		 })();
