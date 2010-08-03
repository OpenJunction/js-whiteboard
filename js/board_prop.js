var BoardProp = JunctionProps.ListProp.extend(
	{
		init: function(propName){
			this._super(propName);
		},

		newStroke: function(color, width, inPoints){
			var obj = {
				id: Math.floor(Math.random() * 99999999999999999),
				color: color,
				width: width,
				points: inPoints.slice()
			};
			return obj;
		}

	});