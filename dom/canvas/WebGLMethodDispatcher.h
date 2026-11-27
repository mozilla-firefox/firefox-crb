/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef WEBGLMETHODDISPATCHER_H_
#define WEBGLMETHODDISPATCHER_H_

#include "HostWebGLContext.h"
#include "TexUnpackBlob.h"
#include "WebGLQueueParamTraits.h"

namespace mozilla {

// The list order defines the command IDs shared by the client and parent.
#define WEBGL_COMMAND_LIST(COMMAND)       \
  COMMAND(CreateBuffer)                   \
  COMMAND(CreateFramebuffer)              \
  COMMAND(CreateProgram)                  \
  COMMAND(CreateQuery)                    \
  COMMAND(CreateRenderbuffer)             \
  COMMAND(CreateSampler)                  \
  COMMAND(CreateShader)                   \
  COMMAND(CreateSync)                     \
  COMMAND(CreateTexture)                  \
  COMMAND(CreateTransformFeedback)        \
  COMMAND(CreateVertexArray)              \
                                          \
  COMMAND(DeleteBuffer)                   \
  COMMAND(DeleteFramebuffer)              \
  COMMAND(DeleteProgram)                  \
  COMMAND(DeleteQuery)                    \
  COMMAND(DeleteRenderbuffer)             \
  COMMAND(DeleteSampler)                  \
  COMMAND(DeleteShader)                   \
  COMMAND(DeleteSync)                     \
  COMMAND(DeleteTexture)                  \
  COMMAND(DeleteTransformFeedback)        \
  COMMAND(DeleteVertexArray)              \
                                          \
  COMMAND(SetEnabled)                     \
  COMMAND(GenerateError)                  \
  COMMAND(Resize)                         \
  COMMAND(RequestExtension)               \
  COMMAND(DidRefresh)                     \
  COMMAND(AttachShader)                   \
  COMMAND(BindAttribLocation)             \
  COMMAND(BindFramebuffer)                \
  COMMAND(BlendColor)                     \
  COMMAND(BlendEquationSeparate)          \
  COMMAND(BlendFuncSeparate)              \
  COMMAND(Clear)                          \
  COMMAND(ClearColor)                     \
  COMMAND(ClearDepth)                     \
  COMMAND(ClearStencil)                   \
  COMMAND(ClipControlEXT)                 \
  COMMAND(ColorMask)                      \
  COMMAND(CompileShader)                  \
  COMMAND(CullFace)                       \
  COMMAND(DepthFunc)                      \
  COMMAND(DepthMask)                      \
  COMMAND(DepthRange)                     \
  COMMAND(DetachShader)                   \
  COMMAND(Flush)                          \
  COMMAND(FramebufferAttach)              \
  COMMAND(FrontFace)                      \
  COMMAND(Hint)                           \
  COMMAND(LineWidth)                      \
  COMMAND(LinkProgram)                    \
  COMMAND(PolygonOffset)                  \
  COMMAND(PolygonOffsetClampEXT)          \
  COMMAND(ProvokingVertex)                \
  COMMAND(Present)                        \
  COMMAND(SampleCoverage)                 \
  COMMAND(Scissor)                        \
  COMMAND(SetDrawingBufferColorSpace)     \
  COMMAND(SetUnpackColorSpace)            \
  COMMAND(ShaderSource)                   \
  COMMAND(StencilFuncSeparate)            \
  COMMAND(StencilMaskSeparate)            \
  COMMAND(StencilOpSeparate)              \
  COMMAND(Viewport)                       \
  COMMAND(BindBuffer)                     \
  COMMAND(BindBufferRange)                \
  COMMAND(CopyBufferSubData)              \
  COMMAND(BufferData)                     \
  COMMAND(BufferData_SizeOnly)            \
  COMMAND(BufferSubData)                  \
  COMMAND(BlitFramebuffer)                \
  COMMAND(InvalidateFramebuffer)          \
  COMMAND(InvalidateSubFramebuffer)       \
  COMMAND(ReadBuffer)                     \
  COMMAND(RenderbufferStorageMultisample) \
  COMMAND(ActiveTexture)                  \
  COMMAND(BindTexture)                    \
  COMMAND(GenerateMipmap)                 \
  COMMAND(CopyTexImage)                   \
  COMMAND(TexStorage)                     \
  COMMAND(TexImage)                       \
  COMMAND(CompressedTexImage)             \
  COMMAND(TexParameter_base)              \
  COMMAND(UseProgram)                     \
  COMMAND(UniformData)                    \
  COMMAND(VertexAttrib4T)                 \
  COMMAND(VertexAttribDivisor)            \
  COMMAND(UniformBlockBinding)            \
  COMMAND(EnableVertexAttribArray)        \
  COMMAND(DisableVertexAttribArray)       \
  COMMAND(VertexAttribPointer)            \
  COMMAND(ClearBufferTv)                  \
  COMMAND(ClearBufferfi)                  \
  COMMAND(ReadPixelsPbo)                  \
  COMMAND(BindSampler)                    \
  COMMAND(SamplerParameteri)              \
  COMMAND(SamplerParameterf)              \
  COMMAND(BindTransformFeedback)          \
  COMMAND(BeginTransformFeedback)         \
  COMMAND(EndTransformFeedback)           \
  COMMAND(PauseTransformFeedback)         \
  COMMAND(ResumeTransformFeedback)        \
  COMMAND(TransformFeedbackVaryings)      \
  COMMAND(DrawBuffers)                    \
  COMMAND(BindVertexArray)                \
  COMMAND(DrawArraysInstanced)            \
  COMMAND(DrawElementsInstanced)          \
  COMMAND(BeginQuery)                     \
  COMMAND(EndQuery)                       \
  COMMAND(QueryCounter)                   \
  COMMAND(SetFramebufferIsInOpaqueRAF)    \
  COMMAND(ClearVRSwapChain)               \
  COMMAND(CopyToSwapChain)                \
  COMMAND(EndOfFrame)

// Each command starts with its numeric ID serialized as size_t, followed by
// its arguments.
enum class WebGLCommandId : size_t {
#define DEFINE_WEBGL_COMMAND_ID(NAME) NAME,
  WEBGL_COMMAND_LIST(DEFINE_WEBGL_COMMAND_ID)
#undef DEFINE_WEBGL_COMMAND_ID
      Count
};

inline constexpr size_t kWebGLCommandCount =
    static_cast<size_t>(WebGLCommandId::Count);

template <size_t Id>
class WebGLMethodDispatcher;

#define DEFINE_METHOD_DISPATCHER(ID, METHOD)                                  \
  template <>                                                                 \
  class WebGLMethodDispatcher<ID>                                             \
      : public MethodDispatcher<WebGLMethodDispatcher, ID, decltype(&METHOD), \
                                &METHOD> {                                    \
   public:                                                                    \
    static const char* Name() { return #METHOD; }                             \
  };                                                                          \
  template <>                                                                 \
  inline WebGLMethodInfo WebGLMethodInfo::Get<decltype(&METHOD), &METHOD>() { \
    return {ID, 0};                                                           \
  }

#define DEFINE_WEBGL_COMMAND(NAME)                                    \
  DEFINE_METHOD_DISPATCHER(static_cast<size_t>(WebGLCommandId::NAME), \
                           HostWebGLContext::NAME)
WEBGL_COMMAND_LIST(DEFINE_WEBGL_COMMAND)
#undef DEFINE_WEBGL_COMMAND
#undef DEFINE_METHOD_DISPATCHER
#undef WEBGL_COMMAND_LIST

}  // namespace mozilla

#endif  // WEBGLMETHODDISPATCHER_H_
