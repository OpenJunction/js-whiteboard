var BoardProp = JunctionProps.ListProp.extend(
	{
		init: function(propName){
			this._super(propName, new this.StrokeBuilder());
		},

		addStroke: function(stroke){
			this.add(stroke);
		},

		StrokeBuilder: Class.extend(
			{
				destringify: function(s){
					return BoardProp.prototype.destringifyStroke(s);
				}
			}),

		destringifyStroke: function(s){
			try{
				var obj = JSON.parse(s);
				var color = obj.color;
				var width = obj.width;
				var a = obj.points;
				var points = [];
				for(var i = 0; i < a.length; i++){
					var p = this.destringifyPoint(a[i]);
					points.push(p);
				}
				return new this.Stroke(color, width, points);
			}
			catch(e){
				return new this.Stroke(0, 0, []);
			}
		},

		Stroke: Class.extend(
			{

				init: function(color, width, points){
					this.points = points;
					this.color = color;
					this.width = width;
					
					var pointStr = "";
					for(var i = 0; i < this.points.length; i++){
						pointStr += this.points[i].stringify();
					}
					this.hash = color + "," + width + "," + pointStr;
				},

				addPoint: function(x, y){
					var p = new BoardProp.prototype.Point(x,y);
					var newPoints = this.points.slice(0);
					newPoints.push(p);
					return new BoardProp.prototype.Stroke(this.color, this.width, newPoints);
				},

				equals: function(other) {
					return other.hash == this.hash;
				},

				copy: function(){
					return new BoardProp.prototype.Stroke(this.color, this.width, this.points);
				},

				stringify: function(){ 
					var obj = {
						color: this.color,
						width: this.width,
						points: []
					};
					for(var i = 0; i < this.points.length; i++){
						obj.points.push(this.points[i].stringify());
					}
					return JSON.stringify(obj);
				}

			}),


		destringifyPoint: function(s) {
			var parts = s.split(",");
			if(parts.length == 2){
				var x = parseInt(parts[0]);
				var y = parseInt(parts[1]);
				return new this.Point(x,y);
			}
			else {
				return new this.Point(-1,-1);
			}
		},

		Point: Class.extend(
			{
				init: function(x, y){
					this.x = x;
					this.y = y;
				},
				equals: function(other) {
					return other.x == this.x && other.y == this.y;
				},
				stringify: function() {
					return this.x + "," + this.y;
				}
			})
		

	});