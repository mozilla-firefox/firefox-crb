<?xml version="1.0"?>
<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->

<!DOCTYPE overlay>

<xsl:stylesheet version="1.0"
                xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
                xmlns="http://www.w3.org/1999/xhtml">

  <xsl:output method="xml"/>

  <!-- The size is the number of elements and attributes. Above large-size,
       only elements at a depth lower than large-open-depth are open. Above
       huge-size, the document is shown as plain text without collapsible
       elements. -->
  <xsl:variable name="large-size" select="100000"/>
  <xsl:variable name="huge-size" select="200000"/>
  <xsl:variable name="large-open-depth" select="2"/>

  <xsl:variable name="size"
                select="count(/descendant::*) + count(/descendant::*/@*)"/>
  <xsl:variable name="large" select="$size &gt; $large-size"/>
  <xsl:variable name="huge" select="$size &gt; $huge-size"/>

  <xsl:template match="/">
    <div id="top">
      <link rel="stylesheet" href="resource://content-accessible/XMLPrettyPrint.css"/>
      <div id="header">
        <p id="nostylesheet" data-l10n-id="xml-nostylesheet"><a data-l10n-name="addons-link" href="https://addons.mozilla.org/firefox/search/?q=xslt+polyfill"></a></p>
      </div>
      <xsl:choose>
        <xsl:when test="$huge">
          <main id="tree" class="raw">
            <xsl:apply-templates mode="raw"/>
          </main>
        </xsl:when>
        <xsl:otherwise>
          <main id="tree" class="highlight">
            <xsl:apply-templates/>
          </main>
        </xsl:otherwise>
      </xsl:choose>
    </div>
  </xsl:template>

  <xsl:template match="*">
    <div>
      <xsl:text>&lt;</xsl:text>
      <span class="start-tag"><xsl:value-of select="name(.)"/></span>
      <xsl:apply-templates select="@*"/>
      <xsl:text>/&gt;</xsl:text>
    </div>
  </xsl:template>

  <xsl:template match="*[node()]">
    <div><xsl:apply-templates mode="space" select="@xml:space"/>
      <xsl:text>&lt;</xsl:text>
      <span class="start-tag"><xsl:value-of select="name(.)"/></span>
      <xsl:apply-templates select="@*"/>
      <xsl:text>&gt;</xsl:text>

      <span class="text"><xsl:value-of select="."/></span>

      <xsl:text>&lt;/</xsl:text>
      <span class="end-tag"><xsl:value-of select="name(.)"/></span>
      <xsl:text>&gt;</xsl:text>
    </div>
  </xsl:template>

  <xsl:template match="*[* or processing-instruction() or comment() or string-length(.) &gt; 50]">
    <div><xsl:apply-templates mode="space" select="@xml:space"/>
      <details class="expandable-body">
        <xsl:if test="not($large) or count(ancestor::*) &lt; $large-open-depth">
          <xsl:attribute name="open"/>
        </xsl:if>
        <summary class="expandable-opening">
          <xsl:text>&lt;</xsl:text>
          <span class="start-tag"><xsl:value-of select="name(.)"/></span>
          <xsl:apply-templates select="@*"/>
          <xsl:text>&gt;</xsl:text>
        </summary>

        <div class="expandable-children"><xsl:apply-templates/></div>

      </details>
      <span class="expandable-closing">
        <xsl:text>&lt;/</xsl:text>
        <span class="end-tag"><xsl:value-of select="name(.)"/></span>
        <xsl:text>&gt;</xsl:text>
      </span>
    </div>
  </xsl:template>

  <xsl:template match="@xml:space[string() = 'default']" mode="space">
    <xsl:attribute name="class">space-default</xsl:attribute>
  </xsl:template>
  <xsl:template match="@xml:space[string() = 'preserve']" mode="space">
    <xsl:attribute name="class">space-preserve</xsl:attribute>
  </xsl:template>

  <xsl:template match="@*">
    <xsl:text> </xsl:text>
    <span class="attribute-name"><xsl:value-of select="name(.)"/></span>
    <xsl:text>=</xsl:text>
    <span class="attribute-value">"<xsl:value-of select="."/>"</span>
  </xsl:template>

  <xsl:template match="text()">
    <xsl:if test="normalize-space(.)">
      <xsl:value-of select="."/>
    </xsl:if>
  </xsl:template>

  <xsl:template match="processing-instruction()">
    <div class="pi">
      <xsl:text>&lt;?</xsl:text>
      <xsl:value-of select="name(.)"/>
      <xsl:text> </xsl:text>
      <xsl:value-of select="."/>
      <xsl:text>?&gt;</xsl:text>
    </div>
  </xsl:template>

  <xsl:template match="processing-instruction()[string-length(.) &gt; 50]">
    <div class="pi">
      <details open="" class="expandable-body">
        <summary class="expandable-opening">
          <xsl:text>&lt;?</xsl:text>
          <xsl:value-of select="name(.)"/>
        </summary>
        <div class="expandable-children"><xsl:value-of select="."/></div>
      </details>
      <span class="expandable-closing">
        <xsl:text>?&gt;</xsl:text>
      </span>
    </div>
  </xsl:template>

  <xsl:template match="comment()">
    <div class="comment">
      <xsl:text>&lt;!--</xsl:text>
      <xsl:value-of select="."/>
      <xsl:text>--&gt;</xsl:text>
    </div>
  </xsl:template>

  <xsl:template match="comment()[string-length(.) &gt; 50]">
    <div class="comment">
      <details open="" class="expandable-body">
        <summary class="expandable-opening">
          <xsl:text>&lt;!--</xsl:text>
        </summary>
        <div class="expandable-children">
          <xsl:value-of select="."/>
        </div>
      </details>
      <span class="expandable-closing">
        <xsl:text>--&gt;</xsl:text>
      </span>
    </div>
  </xsl:template>

  <!-- Plain text mode. Only elements with element, comment or processing
       instruction children make a block. All other output is text, which the
       XSLT output handler merges into few text nodes. -->
  <xsl:template match="*" mode="raw">
    <xsl:text>&lt;</xsl:text>
    <xsl:value-of select="name(.)"/>
    <xsl:apply-templates select="@*" mode="raw"/>
    <xsl:choose>
      <xsl:when test="node()">
        <xsl:text>&gt;</xsl:text>
        <xsl:value-of select="normalize-space(.)"/>
        <xsl:text>&lt;/</xsl:text>
        <xsl:value-of select="name(.)"/>
        <xsl:text>&gt;&#10;</xsl:text>
      </xsl:when>
      <xsl:otherwise>
        <xsl:text>/&gt;&#10;</xsl:text>
      </xsl:otherwise>
    </xsl:choose>
  </xsl:template>

  <xsl:template match="*[* or comment() or processing-instruction()]" mode="raw">
    <xsl:text>&lt;</xsl:text>
    <xsl:value-of select="name(.)"/>
    <xsl:apply-templates select="@*" mode="raw"/>
    <xsl:text>&gt;</xsl:text>
    <div class="raw-children"><xsl:apply-templates mode="raw"/></div>
    <xsl:text>&lt;/</xsl:text>
    <xsl:value-of select="name(.)"/>
    <xsl:text>&gt;&#10;</xsl:text>
  </xsl:template>

  <xsl:template match="@*" mode="raw">
    <xsl:text> </xsl:text>
    <xsl:value-of select="name(.)"/>
    <xsl:text>="</xsl:text>
    <xsl:value-of select="."/>
    <xsl:text>"</xsl:text>
  </xsl:template>

  <xsl:template match="text()" mode="raw">
    <xsl:if test="normalize-space(.)">
      <xsl:value-of select="normalize-space(.)"/>
      <xsl:text>&#10;</xsl:text>
    </xsl:if>
  </xsl:template>

  <xsl:template match="processing-instruction()" mode="raw">
    <xsl:text>&lt;?</xsl:text>
    <xsl:value-of select="name(.)"/>
    <xsl:text> </xsl:text>
    <xsl:value-of select="."/>
    <xsl:text>?&gt;&#10;</xsl:text>
  </xsl:template>

  <xsl:template match="comment()" mode="raw">
    <xsl:text>&lt;!--</xsl:text>
    <xsl:value-of select="."/>
    <xsl:text>--&gt;&#10;</xsl:text>
  </xsl:template>

</xsl:stylesheet>
