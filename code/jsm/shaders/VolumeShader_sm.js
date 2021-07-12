import {
	Vector2,
	Vector3
} from '../../build/three.module.js';

/**
 * Shaders to render 3D volumes using raycasting.
 * The applied techniques are based on similar implementations in the Visvis and Vispy projects.
 * This is not the only approach, therefore it's marked 1.
 */

var VolumeRenderShader = {
	uniforms: {
		'u_size': { value: new Vector3( 1, 1, 1 ) },
		'u_renderstyle': { value: 0 },
		'u_renderthreshold': { value: 0.5 },
		'u_clim': { value: new Vector2( 1, 1 ) },
		'u_data': { value: null },
		'u_cmdata': { value: null }
	},
	vertexShader: [
		'		varying vec4 v_nearpos;',
		'		varying vec4 v_farpos;',
		'		varying vec3 v_position;',

		'		void main() {',
		// Prepare transforms to map to "camera view". See also:
		// https://threejs.org/docs/#api/renderers/webgl/WebGLProgram
		'				mat4 viewtransformf = modelViewMatrix;',
		'				mat4 viewtransformi = inverse(modelViewMatrix);',

		// Project local vertex coordinate to camera position. Then do a step
		// backward (in cam coords) to the near clipping plane, and project back. Do
		// the same for the far clipping plane. This gives us all the information we
		// need to calculate the ray and truncate it to the viewing cone.
		'				vec4 position4 = vec4(position, 1.0);',
		'				vec4 pos_in_cam = viewtransformf * position4;',

		// Intersection of ray and near clipping plane (z = -1 in clip coords)
		'				pos_in_cam.z = -pos_in_cam.w;',
		'				v_nearpos = viewtransformi * pos_in_cam;',

		// Intersection of ray and far clipping plane (z = +1 in clip coords)
		'				pos_in_cam.z = pos_in_cam.w;',
		'				v_farpos = viewtransformi * pos_in_cam;',

		// Set varyings and output pos
		'				v_position = position;',
		'				gl_Position = projectionMatrix * viewMatrix * modelMatrix * position4;',
		'		}',
	].join( '\n' ),
	fragmentShader: [
		'		precision highp float;',
		'		precision mediump sampler3D;',

		'		uniform vec3 u_size;',
		'		uniform int u_renderstyle;',
		'		uniform float u_renderthreshold;',
		'		uniform vec2 u_clim;',

		'		uniform sampler3D u_data;',
		'		uniform sampler2D u_cmdata;',

		'		varying vec3 v_position;',
		'		varying vec4 v_nearpos;',
		'		varying vec4 v_farpos;',

		// The maximum distance through our rendering volume is sqrt(3).
		'		const int MAX_STEPS = 887;	// 887 for 512^3, 1774 for 1024^3',
		'		const int REFINEMENT_STEPS = 4;',
		'		const float relative_step_size = 1.5;', // default 1.0
		'		const vec4 ambient_color = vec4(0.2, 0.4, 0.2, 1.0);',
		'		const vec4 diffuse_color = vec4(0.8, 0.2, 0.2, 1.0);',
		'		const vec4 specular_color = vec4(1.0, 1.0, 1.0, 1.0);',
		'		const float shininess = 40.0;',

		'		void cast_mip(vec3 start_loc, vec3 step, int nsteps, vec3 view_ray);',

		'		float sample1(vec3 texcoords);',
		'		vec4 apply_colormap(float val);',


		'		void main() {',
		// Normalize clipping plane info
		'				vec3 farpos = v_farpos.xyz / v_farpos.w;',
		'				vec3 nearpos = v_nearpos.xyz / v_nearpos.w;',

		// Calculate unit vector pointing in the view direction through this fragment.
		'				vec3 view_ray = normalize(nearpos.xyz - farpos.xyz);',

		// Compute the (negative) distance to the front surface or near clipping plane.
		// v_position is the back face of the cuboid, so the initial distance calculated in the dot
		// product below is the distance from near clip plane to the back of the cuboid
		'				float distance = dot(nearpos - v_position, view_ray);',
		'				distance = max(distance, min((-0.5 - v_position.x) / view_ray.x,',
		'																		(u_size.x - 0.5 - v_position.x) / view_ray.x));',
		'				distance = max(distance, min((-0.5 - v_position.y) / view_ray.y,',
		'																		(u_size.y - 0.5 - v_position.y) / view_ray.y));',
		'				distance = max(distance, min((-0.5 - v_position.z) / view_ray.z,',
		'																		(u_size.z - 0.5 - v_position.z) / view_ray.z));',

		// Now we have the starting position on the front surface
		'				vec3 front = v_position + view_ray * distance;',

		// Decide how many steps to take
		'				int nsteps = int(-distance / relative_step_size + 0.5);',
		'				if ( nsteps < 1 )',
		'						discard;',

		// Get starting location and step vector in texture coordinates
		'				vec3 step = ((v_position - front) / u_size) / float(nsteps);',
		'				vec3 start_loc = front / u_size;',

		// For testing: show the number of steps. This helps to establish
		// whether the rays are correctly oriented
		//'gl_FragColor = vec4(0.0, float(nsteps) / 1.0 / u_size.x, 1.0, 1.0);',
		//'return;',

		'				cast_mip(start_loc, step, nsteps, view_ray);',

		'		}',


		'		float sample1(vec3 texcoords) {',
		'				/* Sample float value from a 3D texture. Assumes intensity data. */',
		'				return texture(u_data, texcoords.xyz).r;',
		'		}',


		'		vec4 apply_colormap(float val) {',
		'				val = (val - u_clim[0]) / (u_clim[1] - u_clim[0]);',
		'				return texture2D(u_cmdata, vec2(val, 0.5));',
		'		}',


		'		void cast_mip(vec3 start_loc, vec3 step, int nsteps, vec3 view_ray) {',

		'				float max_val = -1e6;',
		'				int max_i = 100;',
		'				vec3 loc = start_loc;',

		// Enter the raycasting loop. In WebGL 1 the loop index cannot be compared with
		// non-constant expression. So we use a hard-coded max, and an additional condition
		// inside the loop.
		'				for (int iter=0; iter<MAX_STEPS; iter++) {',
		'						if (iter >= nsteps)',
		'								break;',
		// Sample from the 3D texture
		'						float val = sample1(loc);',
		// Apply MIP operation
		'						if (val > max_val) {',
		'								max_val = val;',
		'								max_i = iter;',
		'						}',
		// Advance location deeper into the volume
		'						loc += step;',
		'				}',

		// Refine location, gives crispier images
		'				vec3 iloc = start_loc + step * (float(max_i) - 0.5);',
		'				vec3 istep = step / float(REFINEMENT_STEPS);',
		'				for (int i=0; i<REFINEMENT_STEPS; i++) {',
		'						max_val = max(max_val, sample1(iloc));',
		'						iloc += istep;',
		'				}',

		// Resolve final color
		'				gl_FragColor = apply_colormap(max_val);',
		'				if (gl_FragColor.r < 0.1) gl_FragColor.a = 0.2;',
		'		}',


		



	].join( '\n' )
};

export { VolumeRenderShader };
